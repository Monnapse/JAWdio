import os
import pyaudio
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import threading
import time
import soundcard as sc
import soundfile as sf
import sounddevice as sd
import numpy as np
from threading import Lock, Event
import speech_recognition as sr
import datetime

app = Flask(__name__)
socketio = SocketIO(app, async_mode='eventlet')

# Folder where audio files are stored
AUDIO_FOLDER = 'audio'

# Initialize the PyAudio stream
p = pyaudio.PyAudio()

input_device = "Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)"
output_device = "Voicemeeter Input (VB-Audio Voicemeeter VAIO)"

recording_event = threading.Event()

current_playback_thread = None
current_audio_stop_event = Event()
playback_lock = Lock()

selected_category = "Saved"

# Get list of available input/output devices
def get_audio_devices():
    print(sc.default_speaker().name)
    speakers = sc.all_speakers()
    
    return speakers

def get_categories():
    """Get list of categories (subfolders) in the AUDIO_FOLDER."""
    categories = []
    for category in os.listdir(AUDIO_FOLDER):
        category_path = os.path.join(AUDIO_FOLDER, category)
        if os.path.isdir(category_path):  # Only consider folders as categories
            categories.append(category)
    return categories

# Function to stop current audio gracefully
def stop_current_audio():
    global current_playback_thread, current_audio_stop_event
    if current_playback_thread is not None:
        current_audio_stop_event.set()  # Set the stop event flag
        current_playback_thread.join()  # Wait for the thread to finish (this ensures it's properly stopped)
        print("Current audio playback stopped.")
        current_playback_thread = None
        current_audio_stop_event.clear()  # Clear the stop event for the next playback

# Modified play_audio function
def play_audio(filename):
    global current_playback_thread, current_audio_stop_event

    with playback_lock:
        try:
            # Stop the current playback if a new audio file is requested
            stop_current_audio()

            # Read the new audio file
            data, samplerate = sf.read(f"{AUDIO_FOLDER}/{filename}")
            devices = sd.query_devices()
            device_index = next((i for i, d in enumerate(devices) if output_device in d['name']), None)
            if device_index is None:
                device_index = None  # Use default device if not found

            # Define a new function to handle playback
            def audio_playback():
                try:
                    # Get the total duration of the audio
                    audio_duration = len(data) / samplerate
                    start_time = time.time()

                    #print(audio_duration)
                    try:
                        socketio.emit('audio_duration', {'duration': audio_duration}, namespace='/')
                        #print("Emitted audio_duration")
                    except Exception as e:
                        print(f"Failed to emit audio_duration: {e}")

                    # Play the audio
                    sd.play(data, samplerate, device=device_index)
                    while sd.get_stream().active:
                        if current_audio_stop_event.is_set():
                            sd.stop()
                            print("Playback stopped due to new audio request.")
                            break
                        
                        # Emit current playback position
                        current_position = time.time() - start_time
                        socketio.emit('audio_progress', {
                            'current_position': current_position,
                            'total_duration': audio_duration
                        }, namespace='/')
                        socketio.sleep(0.5)  # Emit progress updates every 500ms

                    sd.wait()  # Wait for the audio to finish
                except Exception as e:
                    print(f"Error during playback: {e}")
                    sd.stop()

            # Create a new thread for the audio playback

            #audio_duration = len(data) / samplerate
            #print(audio_duration)
            #try:
            #    socketio.emit('audio_duration', {'duration': audio_duration}, namespace='/')
            #    print("Emitted audio_duration")
            #except Exception as e:
            #    print(f"Failed to emit audio_duration: {e}")

            #current_playback_thread = threading.Thread(target=audio_playback, daemon=True)
            #current_playback_thread.start()
            current_playback_thread = socketio.start_background_task(audio_playback)
            print(f"Started playing {filename}")
        except Exception as e:
            print(f"Error during playback: {e}")

# Record audio function
recording = False
recorded_frames = []


def record_audio():
    timestamp = time.time()
    output_file_name = f"{timestamp}-jawdio.wav"
    sample_rate = 48000 #44100 # 48000
    buffer_size = 4096

    try:
        with sc.get_microphone(id=input_device, include_loopback=True).recorder(samplerate=sample_rate) as mic:
            audio_data = []

            while recording_event.is_set():  # Run while the event is set
                chunk = mic.record(numframes=buffer_size)
                audio_data.append(chunk)

            # Concatenate all audio chunks
            audio_data = np.concatenate(audio_data)
            audio_path = f"{AUDIO_FOLDER}/{selected_category}/{output_file_name}"
            sf.write(file=audio_path, data=audio_data, samplerate=sample_rate)

            # Optional: Transcribe and rename
            new_file_name = transcribe_and_rename(audio_path, f"{AUDIO_FOLDER}/{selected_category}")
            print(f"File saved as: {new_file_name}")
    except Exception as e:
        print(f"Error during recording: {e}")

    #socketio.emit('recording_stopped', {'timestamp': time.time()}, namespace='/')
def transcribe_and_rename(audio_path, path):
    recognizer = sr.Recognizer()
    try:
        # Load audio file
        with sr.AudioFile(audio_path) as source:
            audio_data = recognizer.record(source)

        # Transcribe audio
        text = recognizer.recognize_google(audio_data)

        # Sanitize text for filename (remove invalid characters)
        sanitized_text = "".join(c if c.isalnum() or c in " _-" else "_" for c in text)

        # Rename file
        new_file_path = os.path.join(path, f"{sanitized_text}.wav")
        os.rename(audio_path, new_file_path)

        return new_file_path
    except sr.UnknownValueError:
        print("Speech Recognition could not understand the audio.")
        return audio_path
    except sr.RequestError as e:
        print(f"Could not request results from Speech Recognition service; {e}")
        return audio_path
    except Exception as e:
        print(f"Error during transcription: {e}")
        return audio_path

# Flask routes
@app.route('/')
def index():
    """Render the homepage."""
    categories = get_categories()
    audio_files = get_audio_files_by_category()
    devices = get_audio_devices()
    return render_template('index.html', categories=categories, audio_files=audio_files, devices=devices, input_device=input_device, output_device=output_device)

#@app.route('/get_audio_files', methods=['POST'])
#def get_audio_files_by_category_route():
#    """Handle request to get audio files by category."""
#    category = request.form.get('category', 'all')
#    audio_files = get_audio_files_by_category(category)
#    return jsonify({'new_files': audio_files})

#@socketio.on('new_audio')
#def handle_new_audio(data):
#    """Handle new audio file uploads and emit to clients."""
#    category = data.get('category', 'all')
#    filename = data.get('filename', '')
#    socketio.emit('update_audio_list', {'category': category, 'filename': filename})
#
#@socketio.on('new_category')
#def handle_new_category(data):
#    """Handle new category creation and emit to clients."""
#    category = data.get('category', '')
#    socketio.emit('update_category_list', {'category': category})

# Flask route to handle play audio requests
@app.route('/play_audio', methods=['POST'])
def play():
    filename = request.form.get('filename')

    if filename.startswith(f"{AUDIO_FOLDER}/"):
        filename = filename.removeprefix(f"{AUDIO_FOLDER}/")

    path = f"{AUDIO_FOLDER}/{filename}"
    if not filename or not os.path.exists(path):
        print(f"File not found: {path}")
        return jsonify({'error': 'File not found'}), 400

    # Start the background task to play the audio
    socketio.start_background_task(play_audio, filename)
    return jsonify({'message': f"Playing {filename}"})

# Toggle recording
@app.route('/toggle_record', methods=['POST'])
def toggle_record():
    global recording_event, selected_category

    # Get the JSON data from the request
    data = request.get_json()

    # Access the selected option from the data
    selected_category = data.get('selectedCategory')

    if recording_event.is_set():
        # Stop recording
        recording_event.clear()
        return jsonify({'recording': False})
    else:
        # Start recording
        recording_event = threading.Event()  # Reset the event
        recording_event.set()
        threading.Thread(target=record_audio, daemon=True).start()
        #socketio.emit('recording_started', {'timestamp': time.time()}, namespace='/')
        return jsonify({'recording': True})

#@app.route('/stop_recording', methods=['POST'])
#def stop_recording_route():
#    stop_recording()
#    save_recording()
#    return 'Recording stopped'


@app.route('/set_input', methods=['POST'])
def set_input():
    global input_device
    # Get the JSON data from the request
    data = request.get_json()

    # Access the selected option from the data
    input_device = data.get('selectedDeviceName')

    # Do something with the selected option (e.g., store it, process it)
    print(f'Selected option: {input_device}')

    # Send a response back to the client
    return jsonify({'message': 'Data received successfully', 'selectedOption': input_device})

@app.route('/set_output', methods=['POST'])
def set_output():
    global output_device
    # Get the JSON data from the request
    data = request.get_json()

    # Access the selected option from the data
    output_device = data.get('selectedDeviceName')

    # Do something with the selected option (e.g., store it, process it)
    print(f'Selected option: {output_device}')

    # Send a response back to the client
    return jsonify({'message': 'Data received successfully', 'selectedOption': output_device})

@app.route('/ping', methods=['GET'])
def ping():
    return jsonify({"status": "connected"})

# Start monitoring the audio folder in a background thread
#threading.Thread(target=monitor_audio_folder, daemon=True).start()
#socketio.start_background_task(monitor_audio_folder)

def get_audio_files_by_category():
    """Categorize audio files by their folder names, including empty folders."""
    categories = {}

    # Walk through the directory structure
    for root, dirs, files in os.walk(AUDIO_FOLDER):
        # Get the category from the folder name
        category = os.path.basename(root)

        # Initialize category if it doesn't exist
        if category not in categories:
            categories[category] = []

        # Add audio files to the category
        for file in files:
            if file.endswith('.wav') or file.endswith(".mp3"):
                categories[category].append(file)

    # Ensure all directories (even those without audio files) are represented
    for root, dirs, _ in os.walk(AUDIO_FOLDER):
        category = os.path.basename(root)
        if category not in categories:
            categories[category] = []  # Add empty category if no audio files were found

    return categories


def monitor_audio_folder():
    """Monitor the audio folder for any changes and notify clients."""
    previous_files = get_audio_files_by_category()  # Start with the initial set of audio files by category
    try:
        while True:
            current_files = get_audio_files_by_category()
            if current_files != previous_files:
                new_files = {}
                removed_files = {}
                for category, files in current_files.items():
                    if category not in previous_files:
                        new_files[category] = files
                    else:
                        new_files_in_category = set(files) - set(previous_files.get(category, []))
                        if new_files_in_category:
                            new_files[category] = list(new_files_in_category)

                for category, files in previous_files.items():
                    if category not in current_files:
                        removed_files[category] = files
                    else:
                        removed_files_in_category = set(files) - set(current_files.get(category, []))
                        if removed_files_in_category:
                            removed_files[category] = list(removed_files_in_category)

                # Emit the updated categories and files to all clients
                if new_files or removed_files:
                    socketio.emit('update_audio_files', {
                        'new_files': new_files,
                        'removed_files': removed_files
                    }, namespace='/')

                previous_files = current_files  # Update the previous files list
            socketio.sleep(1)  # Sleep for a short duration before checking again
    except Exception as e:
        print(f"Error in monitor_audio_folder: {e}")

@socketio.on('create_category_folder')
def handle_create_category_folder():
    print("Creating new category")
    category_name = datetime.datetime.now().strftime("%Y-%m-%d %I.%M.%S %p")
    try:
        # Construct the path for the new category folder
        category_path = os.path.join(AUDIO_FOLDER, category_name)

        # Check if the folder already exists
        if not os.path.exists(category_path):
            # Create the new folder for the category
            os.makedirs(category_path)
            print(f"Created new category folder: {category_path}")
        else:
            print(f"Category folder already exists: {category_path}")
    except Exception as e:
        print(f"Error creating category folder: {e}")

@socketio.on('connect', namespace='/')
def handle_connect():
    print('Client connected!')
    try:
        audio_files_by_category = get_audio_files_by_category()
        emit('update_audio_files', {"new_files": audio_files_by_category}, namespace='/')
    except Exception as e:
        print(f"Error during connect: {e}")

# Run the audio folder monitoring in a separate background thread
def start_monitoring():
    """Start monitoring the audio folder."""
    socketio.start_background_task(monitor_audio_folder)

if __name__ == '__main__':
    #socketio.run(app, debug=True, port="2500", host="0.0.0.0")
    start_monitoring()
    socketio.run(app, debug=True, use_reloader=False, port=2500, host="0.0.0.0")
