from lib import window, questions

audio_folder = "audio"


answers = questions.JAWdio_Questions()
print(answers.speaker_id)
window.JAWdio_Window(audio_folder, answers.speaker_id)