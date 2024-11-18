from lib import input, wheel, stopwatch
import tkinter as tk
import soundcard as sc
import soundfile as sf
import numpy as np
from datetime import datetime
import threading

class JAWdio_Window:
    def __init__(self, folder, speaker_id) -> None:
        self.root = tk.Tk()
        self.folder = folder
        self.speaker_id = speaker_id
        self.wheel = wheel.JAWdio_Wheel(self.root, self.folder)
        self.stopwatch = stopwatch.JAWdio_StopWatch(self.root)
        self.input = input.JAWdio_Keybinds(self.root, record_event=self.toggle_record, open_event=self.wheel.toggle_window)

        self.recording = False

        self.root.mainloop()

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
            with sc.get_microphone(id=self.speaker_id, include_loopback=True).recorder(samplerate=sample_rate) as mic:
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
    