import tkinter as tk
import math
import os
import win32gui
from lib import input
import time

class JAWdio_Wheel:
    def __init__(self, root: tk.Tk, folder_path: str):
        self.root = root
        self.root.title("Hover Wheel Selection")

        # Set up the window dimensions
        self.window_width = 400
        self.window_height = 400
        self.center_x = self.window_width // 2
        self.center_y = self.window_height // 2
        self.radius = 150
        self.num_buttons = 6  # Number of emote buttons per page

        # Folder path containing audio files
        self.folder_path = folder_path
        self.audio_files = self.get_audio_files(self.folder_path)

        # Center the window on the active window
        self.center_on_active_window(self.root, self.window_width, self.window_height)

        # Window appearance
        self.root.configure(bg='')
        self.root.overrideredirect(True)
        self.root.attributes('-topmost', True)
        self.root.grab_release()
        self.root.grab_set()

        self.buttons = []
        self.current_page = 0
        self.pages = self.create_audio_pages(self.audio_files)

        self.input = input.JAWdio_Keybinds()

        # Bind scroll events to switch pages
        self.root.bind("<MouseWheel>", self.on_scroll)

    def toggle_window(self):
        """Toggle window visibility."""
        if self.root.state() == 'normal':
            self.root.withdraw()
        else:
            self.root.deiconify()

            self.audio_files = self.get_audio_files(self.folder_path)
            self.pages = self.create_audio_pages(self.audio_files)

            self.unlock_mouse()
            self.create_wheel()
            self.center_on_active_window(self.root, self.window_width, self.window_height)

    def create_wheel(self):
        """Create the emote wheel with audio buttons."""
        self.buttons.clear()  # Clear existing buttons
        angle_gap = 360 / self.num_buttons
        for i, (file_name, creation_time) in enumerate(self.pages[self.current_page]):
            angle = angle_gap * i
            button_x = self.center_x + self.radius * math.cos(math.radians(angle))
            button_y = self.center_y + self.radius * math.sin(math.radians(angle))

            # Format creation time into a readable string
            time_str = time.ctime(creation_time)

            button_text = f"{file_name}\n{time_str}"  # Combine file name and creation time
            button = tk.Label(self.root, text=button_text, bg="lightgrey", width=20, height=2, anchor='w', justify='left')
            button.place(x=button_x - 70, y=button_y - 30)

            # Bind hover events to highlight the button when the mouse enters or leaves it
            button.bind("<Enter>", lambda event, btn=button: self.on_hover(event, btn))
            button.bind("<Leave>", lambda event, btn=button: self.on_leave(event, btn))

            # Bind click event on the button to perform an action when clicked
            button.bind("<Button-1>", lambda event, btn=button: self.on_button_click(event, btn))
            print("Created wheel")
            self.buttons.append(button)

    def on_hover(self, event, button):
        """Handle hover over the button to highlight it."""
        button.config(bg="lightblue")  # Highlight on hover

    def on_leave(self, event, button):
        """Reset button color when hover ends."""
        button.config(bg="lightgrey")  # Reset to default color

    def on_button_click(self, event, button):
        """Handle button click event."""
        # Perform action on button click (e.g., play the selected audio file)
        audio_file = button.cget("text")
        print(f"Playing audio: {audio_file}")
        button.config(bg="yellow")  # Example: Change button color to yellow when clicked

    def on_scroll(self, event):
        """Handle scroll wheel event for page switching."""
        if event.delta > 0:
            self.next_page()
        else:
            self.prev_page()

    def next_page(self):
        """Switch to the next page."""
        self.current_page = (self.current_page + 1) % len(self.pages)
        self.create_wheel()

    def prev_page(self):
        """Switch to the previous page."""
        self.current_page = (self.current_page - 1) % len(self.pages)
        self.create_wheel()

    def get_audio_files(self, folder_path):
        """Get all audio files in the specified folder along with their creation time."""
        audio_extensions = ['.mp3', '.wav', '.ogg', '.flac']
        audio_files = [
            (f, os.path.getctime(os.path.join(folder_path, f))) 
            for f in os.listdir(folder_path) 
            if any(f.endswith(ext) for ext in audio_extensions)
        ]
        return audio_files

    def create_audio_pages(self, audio_files):
        """Create pages of audio files, ensuring no page exceeds the button limit."""
        pages = []
        for i in range(0, len(audio_files), self.num_buttons):
            pages.append(audio_files[i:i + self.num_buttons])
        return pages

    def get_active_window_position_and_size(self):
        """Get the position and size of the active window."""
        hwnd = win32gui.GetForegroundWindow()
        rect = win32gui.GetWindowRect(hwnd)
        width = rect[2] - rect[0]
        height = rect[3] - rect[1]
        x = rect[0]
        y = rect[1]
        return x, y, width, height

    def center_on_active_window(self, window, popup_width, popup_height):
        """Center the window on the active window."""
        x, y, active_width, active_height = self.get_active_window_position_and_size()

        # Calculate the center of the active window
        center_x = x + (active_width - popup_width) // 2
        center_y = y + (active_height - popup_height) // 2

        # Adjust for screen position, make sure it's within the screen bounds
        self.root.geometry(f'{popup_width}x{popup_height}+{center_x}+{center_y}')
        self.root.update_idletasks()  # Force the geometry update to take effect immediately

    def unlock_mouse(self):
        self.root.grab_release()