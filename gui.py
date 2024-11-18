import tkinter as tk
import keyboard
import win32gui
import wheel

# Global flag to track if the popup is open
popup_open = False
popup_window = None

# Create the main window (invisible, small size)
root = tk.Tk()
#root.geometry('1x1')  # Small size to make it invisible
#root.title("Main Window")
#root.overrideredirect(True)

# Function to get the position and size of the active window
def get_active_window_position_and_size():
    hwnd = win32gui.GetForegroundWindow()  # Get the active window's handle
    rect = win32gui.GetWindowRect(hwnd)  # Get the window's position (left, top, right, bottom)
    width = rect[2] - rect[0]  # Calculate the window's width
    height = rect[3] - rect[1]  # Calculate the window's height
    x = rect[0]  # Left position of the active window
    y = rect[1]  # Top position of the active window
    return x, y, width, height  # Return the position and size

# Function to center the window on the active window
def center_on_active_window(window, popup_width, popup_height):
    # Get active window's position and size
    x, y, active_width, active_height = get_active_window_position_and_size()

    # Calculate the position to center the popup window over the active window
    center_x = x + (active_width - popup_width) // 2
    center_y = y + (active_height - popup_height) // 2

    # Set the geometry of the popup window
    window.geometry(f'{popup_width}x{popup_height}+{center_x}+{center_y}')

def on_button_click(row, col):
    print(f"Button clicked at row {row}, col {col}")

# Function to show the popup window
def show_popup():
    global popup_open, popup_window, root
    if not popup_open:
        print("Create wheel")
        popup_window = wheel.HoverWheelApp(root)
    else:
        popup_window.canvas.destroy()
        popup_open = False

# Continuously check for key press
def check_key():
    if keyboard.is_pressed('alt+q'):  # If F1 is pressed
        show_popup()  # Toggle popup visibility
    root.after(100, check_key)  # Repeat every 100ms

# Start checking for key presses
check_key()

# Start the Tkinter event loop
root.mainloop()