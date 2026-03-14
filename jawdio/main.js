const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden', // Native snap/resize support
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.removeMenu();
}

// Window Control Listeners
ipcMain.on('window-controls', (event, action) => {
  if (!mainWindow) return;
  if (action === 'close') app.quit();
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

// Hotkey Management
ipcMain.on('register-hotkey', (event, { key, filename }) => {
  try {
    globalShortcut.unregister(key);
    globalShortcut.register(key, () => {
      if (mainWindow) mainWindow.webContents.send('trigger-sound', filename);
    });
  } catch (err) {
    console.error('Hotkey Registration Failed:', err);
  }
});

ipcMain.on('clear-hotkeys', () => globalShortcut.unregisterAll());

// Mobile Remote Server
const expressApp = express();
expressApp.use(cors());
expressApp.get('/play/:filename', (req, res) => {
  if (mainWindow) mainWindow.webContents.send('trigger-sound', req.params.filename);
  res.sendStatus(200);
});
expressApp.listen(8080, '0.0.0.0');

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });