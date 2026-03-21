const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');

// --- BYPASS CHROME AUTOPLAY POLICY ---
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 850, minWidth: 800, minHeight: 600,
    titleBarStyle: 'hidden', backgroundColor: '#09090b',
    // ADDED: App Icon for taskbar and window
    icon: path.join(__dirname, 'public/jawdio.png'), 
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

// --- DESKTOP CAPTURE (NEW) ---
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// --- NORMAL WEB SERVER (AUTO-START) ---
const expressApp = express();
expressApp.use(cors());

expressApp.use('/handoff', express.raw({ type: '*/*', limit: '100mb' }));

const handleRemotePlay = (req, res) => {
  const filename = req.params.folder ? `${req.params.folder}/${req.params.file}` : req.params.file;
  if (mainWindow) mainWindow.webContents.send('trigger-sound', filename);
  res.sendStatus(200);
};

expressApp.get('/play/:file', handleRemotePlay);
expressApp.get('/play/:folder/:file', handleRemotePlay);

expressApp.get('/engine/:command', (req, res) => {
  if (mainWindow) mainWindow.webContents.send('engine-command', req.params.command);
  res.sendStatus(200);
});

let handoffBuffer = null;
expressApp.post('/handoff', (req, res) => {
  handoffBuffer = req.body;
  res.sendStatus(200);
});
expressApp.get('/handoff', (req, res) => {
  if (!handoffBuffer) return res.status(404).send('No buffer');
  res.setHeader('Content-Type', 'audio/wav');
  res.send(handoffBuffer);
});

expressApp.listen(8080, '0.0.0.0', () => {
  console.log('Remote web server is listening on port 8080');
});

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });