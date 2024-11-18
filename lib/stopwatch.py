import tkinter as tk

class JAWdio_StopWatch:
    def __init__(self, root):
        self.root = root
        self.root.title("Stopwatch")
        
        # Initialize time variables
        self.running = False
        self.time_seconds = 0
        
        # Create UI elements
        self.time_label = tk.Label(root, text="0", font=("Helvetica", 30))
        self.time_label.pack()
        
        # Update the time display
        self.update_time()
    
    def start(self):
        if not self.running:
            self.running = True
            #self.start_button.config(text="Pause")
            self.update_time()
    
    def stop(self):
        if self.running:
            self.running = False
            #self.start_button.config(text="Start")
    
    def reset(self):
        self.time_seconds = 0
        self.time_label.config(text="0")
    
    def update_time(self):
        if self.running:
            self.time_seconds += 1
            self.time_label.config(text=str(self.time_seconds))
        
        # Update every second
        if self.running:
            self.root.after(1000, self.update_time)