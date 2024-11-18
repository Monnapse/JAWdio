from lib import input, wheel
import tkinter as tk

class JAWdio_Window:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.wheel = wheel.JAWdio_Wheel(self.root, "audio")
        self.input = input.JAWdio_Keybinds(self.root,
            open=self.wheel.toggle_window                              
        )

        self.root.mainloop()