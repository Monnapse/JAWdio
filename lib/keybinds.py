import keyboard
import tkinter as tk

class JAWdio_Keybinds:
    def __init__(self, root: tk.Tk, open) -> None:
        self.root = root
        self.open = open
        self.watch_keybinds()

    def watch_keybinds(self):
        if keyboard.is_pressed('alt+q'):
            if self.open != None:
                self.open()
            print("Open")
        self.root.after(100, self.watch_keybinds)