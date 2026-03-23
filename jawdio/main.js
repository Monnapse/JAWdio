const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session } = require('electron');
const { spawn } = require('child_process');
const { createServer } = require('http');
const net = require('net');
const path = require('path');

// --- BYPASS CHROME AUTOPLAY POLICY ---
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DEV_SERVER_ORIGIN = 'http://localhost:3000';
const INTERNAL_BIND_HOST = '0.0.0.0';
const INTERNAL_ORIGIN_HOST = '127.0.0.1';
const PREFERRED_INTERNAL_PORT = 3000;
const REMOTE_CONTROL_PORT = 8080;

let mainWindow = null;
let nextServerProcess = null;
let remoteControlServer = null;
let handoffBuffer = null;
let appOrigin = DEV_SERVER_ORIGIN;

function isTrustedOrigin(candidateUrl) {
  try {
    return new URL(candidateUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

function getStandaloneDir() {
  if (!app.isPackaged) {
    return path.join(__dirname, '.next', 'standalone');
  }

  return path.join(process.resourcesPath, 'app.asar.unpacked', '.next', 'standalone');
}

function getAppIconPath() {
  if (!app.isPackaged) {
    return path.join(__dirname, 'public', 'jawdio.png');
  }

  return path.join(getStandaloneDir(), 'public', 'jawdio.png');
}

function decodeRequestPath(rawPath) {
  return rawPath
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

function addCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendStatus(response, statusCode) {
  response.statusCode = statusCode;
  response.end();
}

function startRemoteControlServer() {
  remoteControlServer = createServer((request, response) => {
    addCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      sendStatus(response, 204);
      return;
    }

    const requestUrl = new URL(
      request.url || '/',
      `http://${request.headers.host || `127.0.0.1:${REMOTE_CONTROL_PORT}`}`,
    );
    const { pathname } = requestUrl;

    if (request.method === 'GET' && pathname.startsWith('/play/')) {
      const filename = decodeRequestPath(pathname.slice('/play/'.length));

      if (filename && mainWindow) {
        mainWindow.webContents.send('trigger-sound', filename);
      }

      sendStatus(response, 200);
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/engine/')) {
      const command = decodeRequestPath(pathname.slice('/engine/'.length));

      if (command && mainWindow) {
        mainWindow.webContents.send('engine-command', command);
      }

      sendStatus(response, 200);
      return;
    }

    if (request.method === 'POST' && pathname === '/handoff') {
      const chunks = [];

      request.on('data', (chunk) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        handoffBuffer = Buffer.concat(chunks);
        sendStatus(response, 200);
      });
      request.on('error', () => {
        sendStatus(response, 500);
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/handoff') {
      if (!handoffBuffer) {
        response.statusCode = 404;
        response.end('No buffer');
        return;
      }

      response.setHeader('Content-Type', 'audio/wav');
      response.end(handoffBuffer);
      return;
    }

    sendStatus(response, 404);
  });

  remoteControlServer.listen(REMOTE_CONTROL_PORT, '0.0.0.0', () => {
    console.log(`Remote control server is listening on port ${REMOTE_CONTROL_PORT}`);
  });
}

function getAvailablePort(preferredPort) {
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();

      server.listen(port, INTERNAL_BIND_HOST, () => {
        const address = server.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : null;

        server.close(() => {
          if (!resolvedPort) {
            reject(new Error('Failed to resolve an internal app port.'));
            return;
          }

          resolve(resolvedPort);
        });
      });

      server.on('error', (error) => {
        server.close(() => {
          if (port === 0) {
            reject(error);
            return;
          }

          resolve(tryPort(0));
        });
      });
    });

  return tryPort(preferredPort);
}

async function waitForServer(origin, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(origin, { cache: 'no-store' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for ${origin}`);
}

async function startInternalServer() {
  if (!app.isPackaged) {
    appOrigin = DEV_SERVER_ORIGIN;
    return;
  }

  const standaloneDir = getStandaloneDir();
  const serverPath = path.join(standaloneDir, 'server.js');
  const port = await getAvailablePort(PREFERRED_INTERNAL_PORT);

  appOrigin = `http://${INTERNAL_ORIGIN_HOST}:${port}`;
  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOSTNAME: INTERNAL_BIND_HOST,
      JAWDIO_DATA_DIR: path.join(app.getPath('userData'), 'data'),
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: 'pipe',
    windowsHide: true,
  });

  nextServerProcess.stdout.on('data', (chunk) => {
    console.log(`[next] ${String(chunk).trim()}`);
  });
  nextServerProcess.stderr.on('data', (chunk) => {
    console.error(`[next] ${String(chunk).trim()}`);
  });
  nextServerProcess.on('exit', (code) => {
    if (nextServerProcess) {
      console.error(`Internal Next server exited with code ${code ?? 'unknown'}`);
    }

    nextServerProcess = null;
  });

  await waitForServer(appOrigin);
}

function stopInternalServer() {
  if (!nextServerProcess) {
    return;
  }

  nextServerProcess.kill();
  nextServerProcess = null;
}

function configureSessionPermissions() {
  const allowlistedPermissions = new Set(['media', 'speaker-selection']);

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      isTrustedOrigin(requestingOrigin) && allowlistedPermissions.has(permission),
  );

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const currentUrl = webContents?.getURL?.() ?? '';
      callback(isTrustedOrigin(currentUrl) && allowlistedPermissions.has(permission));
    },
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    backgroundColor: '#09090b',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(appOrigin);
  mainWindow.removeMenu();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.on('window-controls', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'close') app.quit();
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

ipcMain.on('register-hotkey', (_event, { key, filename }) => {
  try {
    globalShortcut.unregister(key);
    globalShortcut.register(key, () => {
      if (mainWindow) mainWindow.webContents.send('trigger-sound', filename);
    });
  } catch {}
});

ipcMain.on('clear-hotkeys', () => globalShortcut.unregisterAll());

ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  return sources.map((source) => ({ id: source.id, name: source.name }));
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.monnapse.jawdio');
  configureSessionPermissions();
  startRemoteControlServer();
  await startInternalServer();
  createWindow();
}).catch((error) => {
  console.error('Failed to start JAWDIO:', error);
  app.quit();
});

app.on('before-quit', () => {
  stopInternalServer();
  remoteControlServer?.close();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
