from lib import keybinds, wheel
import tkinter as tk

class JAWdio_Window:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.wheel = wheel.JAWdio_Wheel(self.root)
        self.keybinds = keybinds.JAWdio_Keybinds(self.root,
            open=self.wheel.toggle_window                              
        )

        self.root.mainloop()