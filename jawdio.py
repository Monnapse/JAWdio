from lib import window, questions

audio_folder = "audio"


answers = questions.JAWdio_Questions()
window.JAWdio_Window(audio_folder, answers.record_output_id, answers.play_output_id)