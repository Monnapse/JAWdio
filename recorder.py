import soundcard as sc
import soundfile as sf
import numpy as np

OUTPUT_FILE_NAME = "out.wav"
SAMPLE_RATE = 48000
buffer_size = 1024

with sc.get_microphone(id=str(sc.default_speaker().name), include_loopback=True).recorder(samplerate=SAMPLE_RATE) as mic:
    audio_data = []
    try:
        while True:
            # Record a chunk of audio
            chunk = mic.record(numframes=buffer_size)
            audio_data.append(chunk)

    except KeyboardInterrupt:
        # Stop recording when Ctrl + C is pressed
        print("\nRecording stopped.")
    
    audio_data = np.concatenate(audio_data)
    sf.write(file=OUTPUT_FILE_NAME, data=audio_data[:, 0], samplerate=SAMPLE_RATE)