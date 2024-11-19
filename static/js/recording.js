// Start recording
recordButton = document.getElementById("toggle-recording")
$('#toggle-recording').click(function() {
    fetch('/toggle_record', {
        method: 'POST', 
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          selectedCategory: selectedCategory
        })
      })
      .then(response => response.json())
      .then(data => {
        //console.log('Success:', data);
        if (data.recording)
        {
            //console.log('Is Recording');
            recordButton.textContent = "Stop Recording"
        }
        else
        {
            //console.log('Is Not Recording');
            recordButton.textContent = "Start Recording"
        }
      })
      .catch((error) => {
        console.error('Error:', error);
      });
});

//const durationSpan = document.getElementById("duration");
//socket.on("recording_started", function(data) {
//  console.log(`Recording Started: ${data}`)
//  //durationSpan.textContent = data.timestamp; // Update duration in seconds
//  addTimestamp(durationSpan, data.timestamp, false)
//});
//
//socket.on("recording_stopped", function(data) {
//  console.log(`Recording Ended: ${data}`)
//  //durationSpan.textContent = data.timestamp; // Update duration in seconds
//  //addTimestamp(durationSpan, data.timestamp, false)
//});