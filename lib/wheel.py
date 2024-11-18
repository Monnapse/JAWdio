import tkinter as tk
import math

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
        
        self.canvas = tk.Canvas(self.root, width=self.window_width, height=self.window_height)
        self.canvas.pack()

        self.buttons = []

        self.create_wheel()

        self.canvas.bind("<Motion>", self.on_mouse_move)

    def create_wheel(self):
        self.canvas.create_oval(self.center_x - self.radius, self.center_y - self.radius,
                                self.center_x + self.radius, self.center_y + self.radius)

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