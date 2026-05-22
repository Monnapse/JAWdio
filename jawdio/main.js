const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, session } = require('electron');
const { spawn } = require('child_process');
const { createServer } = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// --- BYPASS CHROME AUTOPLAY POLICY ---
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DEV_PORT = Number(process.env.JAWDIO_DEV_PORT) || 3939;
const DEV_SERVER_ORIGIN = `http://localhost:${DEV_PORT}`;
const INTERNAL_BIND_HOST = '0.0.0.0';
const INTERNAL_ORIGIN_HOST = '127.0.0.1';
const PREFERRED_INTERNAL_PORT = Number(process.env.JAWDIO_INTERNAL_PORT) || 3939;
const REMOTE_CONTROL_PORT = 8080;

let mainWindow = null;
let nextServerProcess = null;
let remoteControlServer = null;
let handoffBuffer = null;
let appOrigin = DEV_SERVER_ORIGIN;

// Server-Sent Events fan-out for /engine/stream. Each connected remote browser
// keeps an open HTTP response we write into; we cache the latest published
// snapshot so a freshly-connected client immediately renders the host's state
// without waiting for the next publish tick.
const engineStreamClients = new Set();
let latestEngineSnapshot = null;
let engineStreamKeepAliveTimer = null;

// Audio-preview request → response correlation. The renderer needs to render
// a WAV slice (which is async), so we open the HTTP response, ask the
// renderer to fulfil it via IPC, and write the bytes back when the renderer
// replies. Each request gets a unique id so multiple in-flight previews
// don't collide.
const pendingPreviewResponses = new Map();
let previewRequestCounter = 0;

function broadcastEngineSnapshot(snapshot) {
  latestEngineSnapshot = snapshot;

  if (engineStreamClients.size === 0) {
    return;
  }

  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;

  for (const client of engineStreamClients) {
    try {
      client.write(payload);
    } catch (error) {
      // Closed/broken socket — drop it.
      engineStreamClients.delete(client);
    }
  }
}

function ensureEngineStreamKeepAlive() {
  if (engineStreamKeepAliveTimer) {
    return;
  }

  engineStreamKeepAliveTimer = setInterval(() => {
    if (engineStreamClients.size === 0) {
      clearInterval(engineStreamKeepAliveTimer);
      engineStreamKeepAliveTimer = null;
      return;
    }

    for (const client of engineStreamClients) {
      try {
        client.write(': keep-alive\n\n');
      } catch {
        engineStreamClients.delete(client);
      }
    }
  }, 25_000);
}

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

    if (request.method === 'GET' && pathname === '/engine/preview') {
      const startSec = Number(requestUrl.searchParams.get('start'));
      const endSec = Number(requestUrl.searchParams.get('end'));

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        sendStatus(response, 400);
        return;
      }

      if (!mainWindow) {
        sendStatus(response, 503);
        return;
      }

      const requestId = ++previewRequestCounter;
      pendingPreviewResponses.set(requestId, response);

      // Kill the request if the renderer never responds (no engine running,
      // crash, etc.) so the remote doesn't hang forever.
      const timeoutHandle = setTimeout(() => {
        if (pendingPreviewResponses.has(requestId)) {
          pendingPreviewResponses.delete(requestId);
          try {
            response.statusCode = 504;
            response.end();
          } catch {}
        }
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        pendingPreviewResponses.delete(requestId);
      };
      request.on('close', cleanup);
      request.on('error', cleanup);

      mainWindow.webContents.send('engine-preview-request', {
        id: requestId,
        start: startSec,
        end: endSec,
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/engine/stream') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders?.();

      engineStreamClients.add(response);
      ensureEngineStreamKeepAlive();

      // Send the most recent snapshot to the newcomer so the UI hydrates
      // immediately instead of waiting for the next publish tick.
      if (latestEngineSnapshot) {
        try {
          response.write(`data: ${JSON.stringify(latestEngineSnapshot)}\n\n`);
        } catch {}
      } else {
        response.write(': hello\n\n');
      }

      const cleanup = () => {
        engineStreamClients.delete(response);
      };

      request.on('close', cleanup);
      request.on('error', cleanup);
      return;
    }

    if (request.method === 'POST' && pathname === '/engine/command') {
      const chunks = [];

      request.on('data', (chunk) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const command = body ? JSON.parse(body) : null;

          if (command && mainWindow) {
            mainWindow.webContents.send('engine-command-payload', command);
          }

          sendStatus(response, 200);
        } catch {
          sendStatus(response, 400);
        }
      });
      request.on('error', () => sendStatus(response, 500));
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

// Renderer (host) publishes Clipper state snapshots here, which we fan out to
// every remote browser currently subscribed to /engine/stream.
ipcMain.on('engine-publish', (_event, snapshot) => {
  if (snapshot && typeof snapshot === 'object') {
    broadcastEngineSnapshot(snapshot);
  }
});

// Renderer responds to a preview request with the rendered WAV bytes. Match
// the original HTTP response by request id and stream the audio back.
ipcMain.on('engine-preview-response', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return;

  const { id, bytes } = payload;
  const response = pendingPreviewResponses.get(id);
  if (!response) return;
  pendingPreviewResponses.delete(id);

  if (!bytes) {
    try {
      response.statusCode = 500;
      response.end();
    } catch {}
    return;
  }

  try {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'audio/wav');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'no-store');
    response.end(buffer);
  } catch (error) {
    console.error('Failed to write preview response:', error);
    try {
      response.statusCode = 500;
      response.end();
    } catch {}
  }
});

function getLanAccessUrls() {
  // Derive the port from whatever appOrigin currently resolves to. In dev this
  // is the DEV_SERVER_ORIGIN constant (3000). In packaged builds it's whatever
  // port getAvailablePort negotiated.
  let port = null;

  try {
    const parsed = new URL(appOrigin);
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    port = null;
  }

  if (!port) {
    return [];
  }

  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const name of Object.keys(interfaces)) {
    for (const candidate of interfaces[name] || []) {
      // Filter to LAN IPv4 only: skip internal (loopback) and IPv6 entries.
      // 169.254.x.x are link-local fallbacks that won't reach other devices.
      if (
        candidate.family === 'IPv4' &&
        !candidate.internal &&
        !candidate.address.startsWith('169.254.')
      ) {
        urls.push({
          label: name,
          url: `http://${candidate.address}:${port}`,
          ip: candidate.address,
          port: Number(port),
        });
      }
    }
  }

  return urls;
}

ipcMain.handle('get-lan-urls', () => getLanAccessUrls());

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
