import tkinter as tk
import math

class HoverWheelApp:
    def __init__(self, root) -> None:
        self.root = root
        self.root.title("Hover Wheel Selection")

        # Define window and circle properties
        self.window_width = 400
        self.window_height = 400
        self.center_x = self.window_width // 2
        self.center_y = self.window_height // 2
        self.radius = 150
        self.num_buttons = 6
        
        # Create a canvas to draw the wheel
        self.canvas = tk.Canvas(self.root, width=self.window_width, height=self.window_height)
        self.canvas.pack()

        # List to store buttons/labels
        self.buttons = []

        # Create the wheel
        self.create_wheel()

        # Bind the motion event to track the mouse
        self.canvas.bind("<Motion>", self.on_mouse_move)

    def create_wheel(self):
        # Draw the wheel as a circle
        self.canvas.create_oval(self.center_x - self.radius, self.center_y - self.radius,
                                self.center_x + self.radius, self.center_y + self.radius)

        # Calculate button positions around the circle
        angle_gap = 360 / self.num_buttons
        for i in range(self.num_buttons):
            angle = angle_gap * i
            button_x = self.center_x + self.radius * math.cos(math.radians(angle))
            button_y = self.center_y + self.radius * math.sin(math.radians(angle))

            # Create buttons (using labels here for simplicity)
            button = tk.Label(self.root, text=f"Button {i+1}", bg="lightgrey", width=10, height=2)
            button.place(x=button_x - 50, y=button_y - 20)  # Adjust to center text
            self.buttons.append((button, button_x, button_y))  # Store button and its position

    def on_mouse_move(self, event):
        # Find the closest button to the mouse pointer
        closest_button = None
        min_distance = float('inf')

        for button, bx, by in self.buttons:
            # Calculate the distance from the mouse pointer to the button's position
            distance = math.sqrt((event.x - bx) ** 2 + (event.y - by) ** 2)

            # Check if this button is the closest one
            if distance < min_distance:
                min_distance = distance
                closest_button = button

        # Highlight the closest button by changing its background color
        if closest_button:
            closest_button.config(bg="lightblue")  # Highlight closest button
            # Optionally, reset the background color of others
            for button, bx, by in self.buttons:
                if button != closest_button:
                    button.config(bg="lightgrey")

# Main program
#if __name__ == "__main__":
#    root = tk.Tk()
#    app = HoverWheelApp(root)
#    root.mainloop()
