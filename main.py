import os
import pyaudio
import wave
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import threading
import time

app = Flask(__name__)
socketio = SocketIO(app)

# Folder where audio files are stored
AUDIO_FOLDER = 'audio'

# Initialize the PyAudio stream
p = pyaudio.PyAudio()

input_device = ""
output_device = ""

# Get list of available input/output devices
def get_audio_devices():
    
    
    return devices

# Audio files list
def get_audio_files():
    return [f for f in os.listdir(AUDIO_FOLDER) if f.endswith('.wav') or f.endswith(".mp3")]

# Play audio function
def play_audio(filename):
    wf = wave.open(os.path.join(AUDIO_FOLDER, filename), 'rb')
    stream = p.open(format=pyaudio.paInt16,
                    channels=wf.getnchannels(),
                    rate=wf.getframerate(),
                    output=True)
    
    data = wf.readframes(1024)
    while data:
        stream.write(data)
        data = wf.readframes(1024)
    
    stream.stop_stream()
    stream.close()

# Record audio function
recording = False
recorded_frames = []

def record_audio():
    global recording, recorded_frames
    stream = p.open(format=pyaudio.paInt16,
                    channels=1,
                    rate=44100,
                    input=True,
                    frames_per_buffer=1024)
    
    recorded_frames = []
    while recording:
        data = stream.read(1024)
        recorded_frames.append(data)

    stream.stop_stream()
    stream.close()

def stop_recording():
    global recording
    recording = False

# Save recording to file
def save_recording():
    global recorded_frames
    with wave.open('recorded_audio.wav', 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
        wf.setframerate(44100)
        wf.writeframes(b''.join(recorded_frames))

# Flask routes
@app.route('/')
def index():
    audio_files = get_audio_files()
    devices = get_audio_devices()
    return render_template('index.html', audio_files=audio_files, devices=devices)

@app.route('/play_audio', methods=['POST'])
def play():
    filename = request.form['filename']
    threading.Thread(target=play_audio, args=(filename,)).start()
    return 'Playing audio'

@app.route('/start_recording', methods=['POST'])
def start_recording():
    global recording
    recording = True
    threading.Thread(target=record_audio).start()
    return 'Recording started'

@app.route('/stop_recording', methods=['POST'])
def stop_recording_route():
    stop_recording()
    save_recording()
    return 'Recording stopped'

# WebSocket for real-time audio file updates
def monitor_audio_folder():
    previous_files = set(get_audio_files())
    while True:
        current_files = set(get_audio_files())
        if current_files != previous_files:
            new_files = current_files - previous_files
            removed_files = previous_files - current_files
            if new_files or removed_files:
                socketio.emit('update_audio_files', list(current_files))
            previous_files = current_files
        time.sleep(1)  # Check every second for changes

# Start monitoring the audio folder in a background thread
threading.Thread(target=monitor_audio_folder, daemon=True).start()

# WebSocket handler for incoming connection
@socketio.on('connect')
def handle_connect():
    audio_files = get_audio_files()
    emit('update_audio_files', audio_files)

if __name__ == '__main__':
    socketio.run(app, debug=True)
