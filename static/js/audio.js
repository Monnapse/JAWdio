let selectedCategory = "";

const progressBar = document.getElementById('progress-bar');
const currentTimeLabel = document.getElementById('current-time');
const totalTimeLabel = document.getElementById('total-time');

const socket = io.connect(location.protocol + '//' + document.domain + ':' + location.port); // Connect to Flask-SocketIO server

socket.on('connect', function() {
    console.log('Connected to server');
});

socket.on('update_audio_files', function(data) {
    //console.log("Received data:", data); // Add this log to see the structure of the data
    updateCategories(data);
});

socket.on('audio_duration', function(data) {
    //console.log(`Received Data ${data}`)
    const { duration } = data;
    
    totalTimeLabel.textContent = formatTime(duration);
});

socket.on('audio_progress', function(data) {
    //console.log(`Received Data ${data}`)
    const { current_position, total_duration } = data;

    // Update the progress bar
    progressBar.value = (current_position / total_duration) * 100;

    // Update time labels
    currentTimeLabel.textContent = formatTime(current_position);
    totalTimeLabel.textContent = formatTime(total_duration);
});

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function addNewCategory() {
    socket.emit('create_category_folder');
}

function sanitizeString(string)
{
    return string.replace(/\s+/g, '-').replace(/\./g, "-");
}

function updateCategories(data) {
    // Ensure that data is not undefined or null
    if (data) {
        // Handling new files:
        if (data.new_files) {
            Object.keys(data.new_files).forEach(function(category) {
                // Sanitize category name to make it a valid ID
                const sanitizedCategory = sanitizeString(category);  // Replaces spaces with underscores

                // Add category button if it doesn't exist
                if (!$('#categories button[onclick="switchCategory(\'' + category + '\')"]').length) {
                    $('#categories').append(`<button class="category-button" onclick="switchCategory('${category}')">${category}</button>`);
                }

                // Make sure the category div exists, create it if necessary
                if (!$('#' + sanitizedCategory).length) {
                    $('#audio-files').append(`<div id="${sanitizedCategory}" class="category-content" style="display: none;"></div>`);
                }

                // Add new files to the category div
                if (data.new_files[category]) {
                    data.new_files[category].forEach(function(file) {
                        //console.log("Adding new file:", file);
                        //$('#' + sanitizedCategory).append(`<button class="audio-file-button" onclick="playAudio('${category}/${file}')">${file}</button>`);

                        split = file.split("-jawdio")
                        if (split.length > 1)
                        {
                            const timestamp = parseFloat(split[0]); // Parse the timestamp
                            const formattedTime = formatTimestamp(timestamp);
                            $('#' + sanitizedCategory).append(`<button data-filename="${file}" class="audio-file-button" onclick="playAudio('${category}/${file}')">${formattedTime}</button>`);
                            var newButton = $('#' + sanitizedCategory).find('button[data-filename="' + file + '"]');
                            addTimestamp(newButton, timestamp, true);
                        }
                        else 
                        {
                            $('#' + sanitizedCategory).append(`<button class="audio-file-button" onclick="playAudio('${category}/${file}')">${file}</button>`);
                        }
                    });
                }
            });
        }

        // Handling removed files:
        if (data.removed_files) {
            Object.keys(data.removed_files).forEach(function(category) {
                const sanitizedCategory = category.replace(/\s+/g, '_');  // Replaces spaces with underscores
                data.removed_files[category].forEach(function(file) {
                    $(`#${sanitizedCategory} .audio-file-button:contains('${file}'), 
                        #${sanitizedCategory} [data-filename="${file}"]`).remove();
                });

                // If a category is empty after removing files, remove the category itself
                if ($('#' + sanitizedCategory + ' .audio-file-button').length === 0) {
                    $('#' + sanitizedCategory).remove();
                    $(`button[onclick="switchCategory('${category}')"]`).remove();
                }
            });
        }
    } else {
        console.error("Received invalid data:", data);
    }
}
// Function to switch between categories when a category button is clicked
function switchCategory(category) {
    // Hide all categories
    $('.category-content').hide();
    
    // Show the selected category
    $('#' + sanitizeString(category)).show();

    selectedCategory = category;
}

function playAudio(file) {
    //console.log("Playing audio:", file);
    $.post('/play_audio', { filename: file }, function (response) {
        //console.log(response.message);
    });
}