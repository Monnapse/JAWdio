import sounddevice as sd
import soundfile as sf

# Function to list all available audio devices
def list_audio_devices():
    devices = sd.query_devices()
    for i, device in enumerate(devices):
        print(f"{i}: {device['name']}")

# Load audio file
filename = 'audio/Juice WRLD & Nicki Minaj - AGATS2 (Insecure) (Official Audio) [lVMN4KSK1-8].mp3'  # Replace with the path to your audio file
try:
    data, samplerate = sf.read(filename)
except Exception as e:
    print(f"Error loading audio file: {e}")
    exit()

# List available devices
print("Available audio devices:")
list_audio_devices()

# Choose a specific output device by name
device_name = "Voicemeeter Input (VB-Audio Voicemeeter VAIO)"  # Replace with the desired device name
devices = sd.query_devices()
device_index = next((i for i, d in enumerate(devices) if device_name in d['name']), None)

if device_index is None:
    print(f"Device '{device_name}' not found. Using the default device.")
    device_index = None  # None will use the default device
else:
    print(f"Using device: {device_name} (Index {device_index})")

# Play audio on the chosen device
try:
    sd.play(data, samplerate, device=device_index)
    sd.wait()  # Wait until audio finishes playing
    print("Audio playback finished.")
except Exception as e:
    print(f"Error during playback: {e}")
