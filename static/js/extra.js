// Array to store timestamp objects
let timestamps = [

];

// Format timestamp to human-readable format
function formatTimestamp(timestamp, ago) {
    const now = new Date();
    const timestampDate = new Date(timestamp * 1000); // Convert timestamp to milliseconds
    const diffInSeconds = Math.floor((now - timestampDate) / 1000);

    // Calculate time differences
    const seconds = diffInSeconds % 60;
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    const minutes = diffInMinutes % 60;
    const diffInHours = Math.floor(diffInMinutes / 60);
    const hours = diffInHours % 24;
    const diffInDays = Math.floor(diffInHours / 24);

    let timeString = "";

    // Display days
    if (diffInDays > 0) {
        timeString += `${diffInDays} day${diffInDays !== 1 ? 's' : ''}`;
    }

    // Display hours
    if (hours > 0) {
        if (timeString) timeString += ", ";
        timeString += `${hours} hour${hours !== 1 ? 's' : ''}`;
    }

    // Display minutes
    if (minutes > 0) {
        if (timeString) timeString += " and ";
        timeString += `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }

    // Display seconds
    if (seconds > 0 || timeString === "") {
        if (timeString) timeString += " and ";
        timeString += `${seconds} second${seconds !== 1 ? 's' : ''}`;
    }

    if (ago)
    {
        return timeString + " ago";
    }
    else 
    {
        return timeString;
    }
}   

// Update all timestamps in the list
function updateTimestamps() {
    //const timestampList = document.getElementById("timestampList");

    // Clear the current list
    //timestampList.innerHTML = '';

    // Loop through each timestamp and update its element in the list
    timestamps.forEach((timestampObj) => {
        // If the timestamp's DOM element hasn't been created, create it
        //if (!timestampObj.element) {
        //    const listItem = document.createElement("li");
        //    timestampObj.element = listItem; // Store reference to the list item
        //    timestampList.appendChild(listItem);
        //}
        //console.log(timestampObj.element.textContent)
        // Update the text content of the list item with the formatted time
        timestampObj.element.text(formatTimestamp(timestampObj.timestamp, timestampObj.ago));
    });
}

// Update the timestamps every second (1000ms)
setInterval(updateTimestamps, 1000);

// Initial update when the page loads
document.addEventListener("DOMContentLoaded", function() {
    updateTimestamps();
});

// Function to add a new timestamp
function addTimestamp(element, timestamp, ago) {
    if (ago = null)
    {
        ago = true;
    }
    //const newTimestamp = Math.floor(Date.now() / 1000); // Current timestamp in seconds

    // Add the new timestamp to the array
    timestamps.push({ timestamp: timestamp, element: element, ago: ago });

    // Ensure the timestamp will be displayed and updated in the future
    updateTimestamps();
}