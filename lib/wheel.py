import tkinter as tk
import math
import win32gui

class JAWdio_Wheel:
    def __init__(self, root):
        self.root = root
        self.root.title("Hover Wheel Selection")

        self.root.overrideredirect(True)

        self.window_width = 400
        self.window_height = 400
        self.center_x = self.window_width // 2
        self.center_y = self.window_height // 2
        self.radius = 150
        self.num_buttons = 6
        
        self.center_on_active_window(self.root, self.window_width, self.window_height)

        self.root.configure(bg='')

        self.canvas = tk.Canvas(self.root, width=self.window_width, height=self.window_height)
        self.canvas.pack()

        self.buttons = []

        self.create_wheel()

        self.canvas.bind("<Motion>", self.on_mouse_move)

    def toggle_window(self):
        if self.root.state() == 'normal':
            self.root.withdraw()
        else:
            self.root.deiconify()
            
    def create_wheel(self):
        self.canvas.create_oval(self.center_x - self.radius, self.center_y - self.radius, self.center_x + self.radius, self.center_y + self.radius)

        angle_gap = 360 / self.num_buttons
        for i in range(self.num_buttons):
            angle = angle_gap * i
            button_x = self.center_x + self.radius * math.cos(math.radians(angle))
            button_y = self.center_y + self.radius * math.sin(math.radians(angle))

            button = tk.Label(self.root, text=f"Button {i+1}", bg="lightgrey", width=10, height=2)
            button.place(x=button_x - 50, y=button_y - 20)
            self.buttons.append((button, button_x, button_y))

    def on_mouse_move(self, event):
        closest_button = None
        min_distance = float('inf')

        for button, bx, by in self.buttons:
            distance = math.sqrt((event.x - bx) ** 2 + (event.y - by) ** 2)

            if distance < min_distance:
                min_distance = distance
                closest_button = button

        if closest_button:
            closest_button.config(bg="lightblue")
            for button, bx, by in self.buttons:
                if button != closest_button:
                    button.config(bg="lightgrey")

    def get_active_window_position_and_size(self):
        hwnd = win32gui.GetForegroundWindow()
        rect = win32gui.GetWindowRect(hwnd)
        width = rect[2] - rect[0]
        height = rect[3] - rect[1]
        x = rect[0]
        y = rect[1]
        return x, y, width, height

    def center_on_active_window(self, window, popup_width, popup_height):
        x, y, active_width, active_height = self.get_active_window_position_and_size()

        center_x = x + (active_width - popup_width) // 2
        center_y = y + (active_height - popup_height) // 2

        window.geometry(f'{popup_width}x{popup_height}+{center_x}+{center_y}')