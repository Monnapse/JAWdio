from lib import input, wheel, stopwatch
import tkinter as tk
import soundcard as sc
import soundfile as sf
import numpy as np
from datetime import datetime
import threading
import wave
import sounddevice as sd

class JAWdio_Window:
    def __init__(self, folder, record_id, play_id) -> None:
        self.root = tk.Tk()
        self.folder = folder
        self.record_id = record_id
        self.play_id = play_id
        self.wheel = wheel.JAWdio_Wheel(self.root, self.folder, self.play_audio)
        self.stopwatch = stopwatch.JAWdio_StopWatch(self.root)
        self.input = input.JAWdio_Keybinds(self.root, record_event=self.toggle_record, open_event=self.wheel.toggle_window)
        self.lock = threading.Lock()
        self.recording = False

        self.root.mainloop()

    def play_audio_on_device(self, file_path, device_name):
        # Load audio file
        try:
            data, samplerate = sf.read(file_path)
        except Exception as e:
            print(f"Error loading audio file: {e}")
            return
        devices = sd.query_devices()
        device_index = next((i for i, d in enumerate(devices) if self.play_id in d['name']), None)

        if device_index is None:
            print(f"Device '{device_name}' not found. Using the default device.")
            device_index = None
        else:
            print(f"Using device: {device_name} (Index {device_index})")

        try:
            sd.play(data, samplerate, device=device_index)
        except Exception as e:
            print(f"Error during playback: {e}")

    def threaded_audio_playback(self, file_path, device_name):
        """Run the audio playback in a separate thread."""
        playback_thread = threading.Thread(
            target=self.play_audio_on_device, 
            args=(file_path, device_name),
            daemon=True  # Ensures the thread exits with the main program
        )
        playback_thread.start()
        return playback_thread

    def play_audio(self, name):
        file_path = f"{self.folder}/{name}"
        self.threaded_audio_playback(file_path, self.play_id)

    def toggle_record(self):
        if self.recording:
            self.recording = False
        else:
            self.recording = True 
            threading.Thread(target=self.record_audio, daemon=True).start()

    def record_audio(self):
        self.stopwatch.reset()
        self.stopwatch.start()
        local_time = datetime.now().strftime("%I-%M-%S %p")
        output_file_name = f"Recording_{local_time}.wav"
        sample_rate = 48000
        buffer_size = 1024

        try:
            with sc.get_microphone(id=self.record_id, include_loopback=True).recorder(samplerate=sample_rate) as mic:
                audio_data = []
                while self.recording:
                    # Record a chunk of audio
                    chunk = mic.record(numframes=buffer_size)
                    if len(audio_data) > 0 and chunk.shape != audio_data[0].shape:
                        print("Chunk shape mismatch")
                        break  # or handle the mismatch appropriately
                    audio_data.append(chunk)

                self.stopwatch.stop()
                audio_data = np.concatenate(audio_data)
                sf.write(file=f"{self.folder}/{output_file_name}", data=audio_data, samplerate=sample_rate)
        except Exception as e:
            print(f"Error during recording: {e}")
    