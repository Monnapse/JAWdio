// Get the select element
const inputElement = document.getElementById('input-devices');
const outputElement = document.getElementById('output-devices');

function select(url, element)
{
    // Get the selected option's value (device ID in this case)
    const selectedValue = element.value;
    const selectedText = element.options[element.selectedIndex].text;

    // Log the selected value and text
    //console.log('Selected device ID:', selectedValue);
    //console.log('Selected device name:', selectedText);

    // Optionally, send the selected data to the server with a POST request
    fetch(url, {
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        selectedDeviceId: selectedValue,
        selectedDeviceName: selectedText
      })
    })
    .then(response => response.json())
    .then(data => {
      //console.log('Success:', data);
    })
    .catch((error) => {
      console.error('Error:', error);
    });
}

// Add an event listener for the 'change' event
inputElement.addEventListener('change', function() {
    select("/set_input", inputElement)
});
outputElement.addEventListener('change', function() {
    select("/set_output", outputElement)
});
