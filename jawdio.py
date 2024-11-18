"""

    JAWdio
    Made by Monnapse

    11/17/2024
    v0.1.0

"""

from pydub import AudioSegment
from pydub.playback import play

audio = AudioSegment.from_file("test.mp3", format="mp3")

play(audio)