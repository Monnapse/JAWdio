import soundcard as sc

class JAWdio_Questions:
    def __init__(self):
        self.record_output_id = None
        self.play_output_id = None

        self.ask_questions()

    def print_speakers(self):
        print(sc.default_speaker().name)
        speakers = sc.all_speakers()
        speaker_index = 0
        for speaker in speakers:
            print(f"{speaker_index} : {speaker.name}")
            speaker_index += 1

    def get_speaker(self, number: int):
        speakers = sc.all_speakers()
        return speakers[number].name

    def ask_questions(self):
        self.print_speakers()
        record_index = int(input("Pick a speaker to record audio on (by index): "))
        self.record_output_id = self.get_speaker(record_index)
        print(self.record_output_id)
        play_index = int(input("Pick a speaker to play audio onto on (by index): "))
        self.play_output_id = self.get_speaker(play_index)
        print(self.play_output_id)