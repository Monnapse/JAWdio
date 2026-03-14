const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const os = require('os');

let mainWindow;
let expressServer = null; // Tracks if the server is running

// Auto-detect local IP address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 850, minWidth: 800, minHeight: 600,
    titleBarStyle: 'hidden', backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadURL('http://localhost:3000');
  mainWindow.removeMenu();
}

ipcMain.on('window-controls', (event, action) => {
  if (!mainWindow) return;
  if (action === 'close') app.quit();
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

ipcMain.on('register-hotkey', (event, { key, filename }) => {
  try {
    globalShortcut.unregister(key);
    globalShortcut.register(key, () => { if (mainWindow) mainWindow.webContents.send('trigger-sound', filename); });
  } catch (err) {}
});

ipcMain.on('clear-hotkeys', () => globalShortcut.unregisterAll());

// --- DYNAMIC WEB REMOTE SERVER ---
const expressApp = express();
expressApp.use(cors());

const handleRemotePlay = (req, res) => {
  const filename = req.params.folder ? `${req.params.folder}/${req.params.file}` : req.params.file;
  if (mainWindow) mainWindow.webContents.send('trigger-sound', filename);
  res.sendStatus(200);
};

expressApp.get('/play/:file', handleRemotePlay);
expressApp.get('/play/:folder/:file', handleRemotePlay);

// IPC Handlers for React to control the server
ipcMain.handle('start-server', async (event, port) => {
  if (expressServer) return { success: false, error: 'Already running' };
  return new Promise((resolve) => {
    try {
      expressServer = http.createServer(expressApp);
      expressServer.listen(port, '0.0.0.0', () => {
        resolve({ success: true, ip: getLocalIp(), port });
      });
      expressServer.on('error', (err) => {
        expressServer = null;
        resolve({ success: false, error: err.message });
      });
    } catch (err) { resolve({ success: false, error: err.message }); }
  });
});

ipcMain.handle('stop-server', async () => {
  if (!expressServer) return { success: true };
  return new Promise((resolve) => {
    expressServer.close(() => {
      expressServer = null;
      resolve({ success: true });
    });
  });
});

ipcMain.handle('get-server-status', () => {
  return { isRunning: !!expressServer, ip: getLocalIp() };
});

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });