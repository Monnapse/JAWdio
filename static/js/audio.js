/*var socket = io.connect(location.protocol + '//' + document.domain + ':' + location.port);

// Handle the real-time update of audio files
socket.on('update_audio_files', function(audioFiles) {
    // Clear the current list
    $('#audio-list').empty();
    audioFiles.forEach(function(filename) {
        split = filename.split("-jawdio")
        if (split.length > 1)
        {
            const timestamp = parseFloat(split[0]); // Parse the timestamp
            const formattedTime = formatTimestamp(timestamp);
            $('#audio-list').append('<li><button class="play-button" data-filename="' + filename + '">' + formattedTime + '</button></li>');
            var newButton = $('#audio-list').find('button[data-filename="' + filename + '"]');
            addTimestamp(newButton, timestamp);
        }
        else 
        {
            $('#audio-list').append('<li><button class="play-button" data-filename="' + filename + '">' + filename + '</button></li>');
        }
    });
});
// Play audio
$(document).ready(function () {
    $('.audio-button').click(function () {
        var filename = $(this).data('file');
        $.post('/play_audio', { filename: filename }, function (response) {
            console.log(response.message);
        });
    });
});*/

let selectedCategory = "";

const socket = io.connect(location.protocol + '//' + document.domain + ':' + location.port); // Connect to Flask-SocketIO server

socket.on('connect', function() {
    console.log('Connected to server');
});

socket.on('update_audio_files', function(data) {
    console.log("Received data:", data); // Add this log to see the structure of the data
    updateCategories(data);
});

function addNewCategory() {
    socket.emit('create_category_folder');
}

function sanitizeString(string)
{
    return string.replace(/\s+/g, '_');
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
                        console.log("Adding new file:", file);
                        $('#' + sanitizedCategory).append(`<button class="audio-file-button" onclick="playAudio('${category}/${file}')">${file}</button>`);
                    });
                }
            });
        }

        // Handling removed files:
        if (data.removed_files) {
            Object.keys(data.removed_files).forEach(function(category) {
                const sanitizedCategory = category.replace(/\s+/g, '_');  // Replaces spaces with underscores
                data.removed_files[category].forEach(function(file) {
                    // Remove the specific file from the DOM
                    $(`#${sanitizedCategory} .audio-file-button:contains('${file}')`).remove();
                });

                // If a category is empty after removing files, remove the category itself
                if ($('#' + sanitizedCategory + ' .audio-file-button').length === 0) {
                    $('#' + sanitizedCategory).remove();
                    $(`button[onclick="switchCategory('${sanitizedCategory}')"]`).remove();
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
    $('#' + category).show();

    selectedCategory = category;
}

function playAudio(file) {
    console.log("Playing audio:", file);
    $.post('/play_audio', { filename: file }, function (response) {
        console.log(response.message);
    });
}