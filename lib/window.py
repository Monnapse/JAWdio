from lib import keybinds, wheel
import tkinter as tk

class JAWdio_Window:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.keybinds = keybinds.JAWdio_Keybinds(self.root,
            open=self.open_window                              
        )
        self.wheel = wheel.JAWdio_Wheel(self.root)

        self.root.mainloop()

    def open_window(self):
        print("Open Window")