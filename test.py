import soundcard as sc
def get_audio_devices():
    print(sc.default_speaker().name)
    speakers = sc.all_speakers()
    
    return speakers

for i in get_audio_devices():
    print(i.name)