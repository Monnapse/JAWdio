import soundcard as sc

class JAWdio_Questions:
    def __init__(self):
        self.speaker_id = None

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
        speaker_index = int(input("Pick a speaker by index: "))
        self.speaker_id = self.get_speaker(speaker_index)