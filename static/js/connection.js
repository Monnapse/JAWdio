let attempts = 0;

async function checkConnection() {
    const timeout = 5000;

    try {
        const response = await Promise.race([
            fetch('/ping'),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), timeout))
        ]);

        if (response.ok) {
            document.getElementById('status').textContent = 'Server Connected';
            document.getElementById('status').className = 'connected';
            attempts = 0;  // Reset attempts if successful
        } else {
            throw new Error('Server error');
        }
    } catch (error) {
        document.getElementById('status').textContent = 'Server Disconnected';
        document.getElementById('status').className = 'disconnected';
        if (attempts < 3) {
            attempts++;
            setTimeout(checkConnection, 2000 * attempts);  // Retry with backoff
        }
    }
}

// Ping the server every 5 seconds
setInterval(checkConnection, 2500);
checkConnection(); // Initial check