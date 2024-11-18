import keyboard
import tkinter as tk

class JAWdio_Keybinds:
    def __init__(self, 
        root: tk.Tk = None, 
        record_keybind: str = "alt+y",
        record_event = None,
        open_keybind: str = "alt+q",
        open_event = None
    ) -> None:
        self.root = root
        self.record_keybind = record_keybind
        self.record_event = record_event
        self.open_keybind = open_keybind
        self.open_event = open_event
        self.watch_keybinds()

    def watch_keybinds(self):
        if self.root != None:
            if keyboard.is_pressed(self.open_keybind):
                if self.open_event != None:
                    self.open_event()
            elif keyboard.is_pressed(self.record_keybind):
                if self.record_event != None:
                    self.record_event()
            self.root.after(100, self.watch_keybinds)