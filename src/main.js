'use strict';

/**
 * Codes 0.2 - Electron main process.
 *
 * Responsibilities:
 *   - Register the custom `app://` (UI) and `preview://` (project preview) protocols.
 *     Custom schemes are required because ES modules cannot be loaded over file://
 *     (Chromium blocks them with a CORS error), and CodeMirror 6 ships as ESM.
 *   - Own the window, the native menus and every privileged operation.
 *   - Expose a narrow, explicit IPC surface to the sandboxed renderer.
 *
 * The renderer never receives Node.js access: contextIsolation is on,
 * nodeIntegration is off and the preload only forwards whitelisted channels.
 */

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');

/** Root of the Codes installation (the folder that holds package.json). */
const APP_ROOT = path.resolve(__dirname, '..');

const IS_DEV = process.argv.includes('--dev');
const SELFTEST = process.argv.includes('--selftest');

/** Shell sessions (cmd / powershell) keyed by session id. */
const shellSessions = new Map();
/** One-shot child processes started by "Run" (node script.js). */
const runSessions = new Map();

const state = {
  mainWindow: null,
  previewWindow: null,
  projectRoot: null,
  previewBase: null,
  recent: [],
  nodeInfo: { available: false, version: null },
};

/* ------------------------------------------------------------------ *
 * Utility helpers
 * ------------------------------------------------------------------ */

const ok = (data) => ({ ok: true, data });
const fail = (error) => ({
  ok: false,
  error: error && error.message ? error.message : String(error),
});

/**
 * Resolve `rel` inside `base` and refuse anything that escapes it.
 * @returns {string|null} absolute path, or null when the path is not allowed
 */
function safeResolve(base, rel) {
  const target = path.resolve(base, rel || '.');
  const normalizedBase = path.resolve(base);
  if (target === normalizedBase) return target;
  if (target.startsWith(normalizedBase + path.sep)) return target;
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      return new Response('Directory listing is not available', { status: 403 });
    }
    const data = await fsp.readFile(filePath);
    return new Response(data, {
      status: 200,
      headers: {
        'content-type': mimeFor(filePath),
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    const status = err && err.code === 'ENOENT' ? 404 : 500;
    return new Response(`Cannot read file: ${err.message}`, { status });
  }
}

/* ------------------------------------------------------------------ *
 * Protocols
 * ------------------------------------------------------------------ */

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: 'preview',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerProtocols() {
  // The Codes UI itself (renderer + node_modules for CodeMirror's ESM build).
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = safeResolve(APP_ROOT, rel);
    if (!target) return new Response('Forbidden', { status: 403 });
    return serveFile(target);
  });

  // Live preview of the project that is currently open.
  protocol.handle('preview', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const base = state.previewBase || state.projectRoot || APP_ROOT;
    const target = safeResolve(base, rel);
    if (!target) return new Response('Forbidden', { status: 403 });
    return serveFile(target);
  });
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a0e15',
    title: 'Codes',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      backgroundThrottling: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  if (SELFTEST) {
    // Electron changed this signature over time; support both shapes.
    win.webContents.on('console-message', function consoleMessage(event, level, message) {
      const resolvedLevel = typeof level === 'number' ? level : event?.level;
      const resolvedMessage = typeof message === 'string' ? message : event?.message;
      const isError = resolvedLevel === 3 || resolvedLevel === 'error';
      if (isError) {
        state.rendererErrors = state.rendererErrors || [];
        state.rendererErrors.push(resolvedMessage || 'unknown renderer error');
      }
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        const { runSelfTest } = require('../scripts/selftest.js');
        runSelfTest({ state, sendToRenderer, shutdownSessions }).catch((error) => {
          console.error('Self test crashed:', error);
          app.exit(1);
        });
      }, 900);
    });
  }

  win.on('closed', () => {
    state.mainWindow = null;
    shutdownSessions();
  });

  // Never let the renderer navigate away from the app shell.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://codes/')) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadURL('app://codes/src/index.html');
  return win;
}

function createPreviewWindow(filePath) {
  const root = state.projectRoot;
  const insideProject = root && isInside(root, filePath);
  const base = insideProject ? root : path.dirname(filePath);
  const rel = path.relative(base, filePath).split(path.sep).join('/');
  state.previewBase = base;

  if (state.previewWindow && !state.previewWindow.isDestroyed()) {
    state.previewWindow.loadURL(`preview://local/${rel}`);
    state.previewWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: 'Preview',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('closed', () => {
    state.previewWindow = null;
  });

  state.previewWindow = win;
  win.loadURL(`preview://local/${rel}`);
}

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

/* ------------------------------------------------------------------ *
 * Shell sessions (real Windows processes)
 * ------------------------------------------------------------------ */

/**
 * Shell definitions.
 *
 * cmd.exe:
 *   `/d`  - skip AutoRun commands
 *   `/q`  - do not echo the command back (Codes renders the typed line itself,
 *           which keeps the echo identical for every shell)
 *   `/k`  - stay alive after the startup command
 *   `prompt $P$G` prints the full path + ">" so Codes can display a real
 *   prompt and track `cd` changes.
 *   NOTE: `chcp 65001` must NOT be used here. cmd.exe already speaks UTF-8 on
 *   redirected pipes when it has no console of its own (the Electron case);
 *   forcing the code page actually corrupts the byte stream.
 *
 * powershell.exe:
 *   UTF-8 is requested explicitly for both input and output.
 */
const SHELLS = {
  cmd: {
    id: 'cmd',
    label: 'CMD',
    file: 'cmd.exe',
    args: ['/d', '/q', '/k', 'prompt $P$G'],
  },
  powershell: {
    id: 'powershell',
    label: 'PowerShell',
    file: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NoExit',
      '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
        '[Console]::InputEncoding=[Text.Encoding]::UTF8; ' +
        'prompt',
    ],
  },
};

function startShellSession(kind, cwd) {
  const def = SHELLS[kind] || SHELLS.cmd;
  const workdir = cwd && fs.existsSync(cwd) ? cwd : APP_ROOT;
  const id = randomUUID();

  const proc = spawn(def.file, def.args, {
    cwd: workdir,
    windowsHide: true,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  const session = {
    id,
    kind: def.id,
    label: def.label,
    proc,
    cwd: workdir,
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    alive: true,
  };

  proc.stdout.on('data', (chunk) => {
    sendToRenderer('terminal:output', { id, stream: 'stdout', text: session.stdoutDecoder.write(chunk) });
  });
  proc.stderr.on('data', (chunk) => {
    sendToRenderer('terminal:output', { id, stream: 'stderr', text: session.stderrDecoder.write(chunk) });
  });

  proc.on('error', (err) => {
    sendToRenderer('terminal:output', {
      id,
      stream: 'system',
      text: `\n[Codes] ${def.label} could not be started: ${err.message}\n`,
    });
    session.alive = false;
  });

  proc.on('exit', (code) => {
    session.alive = false;
    shellSessions.delete(id);
    sendToRenderer('terminal:exit', { id, code: code === null ? 1 : code });
  });

  shellSessions.set(id, session);
  return { id, kind: def.id, label: def.label, cwd: workdir };
}

function writeToShell(id, data) {
  const session = shellSessions.get(id);
  if (!session || !session.alive) return false;
  try {
    session.proc.stdin.write(data);
    return true;
  } catch {
    return false;
  }
}

function killShell(id) {
  const session = shellSessions.get(id);
  if (!session) return false;
  try {
    session.proc.kill();
  } catch {
    /* already gone */
  }
  shellSessions.delete(id);
  return true;
}

/* ------------------------------------------------------------------ *
 * Run (node script.js)
 * ------------------------------------------------------------------ */

function startRunSession(filePath, cwd) {
  const id = randomUUID();
  const workdir = cwd && fs.existsSync(cwd) ? cwd : APP_ROOT;

  const proc = spawn('node', [filePath], {
    cwd: workdir,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const session = { id, proc, alive: true };
  const decoder = new StringDecoder('utf8');

  proc.stdout.on('data', (chunk) => {
    sendToRenderer('terminal:output', { id, stream: 'stdout', text: decoder.write(chunk) });
  });
  proc.stderr.on('data', (chunk) => {
    sendToRenderer('terminal:output', { id, stream: 'stderr', text: decoder.write(chunk) });
  });

  proc.on('error', (err) => {
    sendToRenderer('terminal:output', {
      id,
      stream: 'system',
      text: `\n[Codes] Could not start Node.js: ${err.message}\n`,
    });
    session.alive = false;
  });

  proc.on('exit', (code) => {
    session.alive = false;
    runSessions.delete(id);
    sendToRenderer('terminal:exit', { id, code: code === null ? 1 : code });
  });

  runSessions.set(id, session);
  return { id };
}

function killRun(id) {
  const session = runSessions.get(id);
  if (!session) return false;
  try {
    // /T also terminates child processes spawned by the script.
    spawn('taskkill', ['/pid', String(session.proc.pid), '/f', '/t'], { windowsHide: true });
  } catch {
    /* ignore */
  }
  try {
    session.proc.kill();
  } catch {
    /* ignore */
  }
  runSessions.delete(id);
  return true;
}

function shutdownSessions() {
  for (const id of [...shellSessions.keys()]) killShell(id);
  for (const id of [...runSessions.keys()]) killRun(id);
}

function sendToRenderer(channel, payload) {
  if (SELFTEST) {
    if (channel === 'terminal:output') {
      state.testOutput = (state.testOutput || '').concat(payload.text || '');
    }
  }
  const win = state.mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ *
 * Recent projects
 * ------------------------------------------------------------------ */

function recentFilePath() {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

function loadRecent() {
  try {
    const raw = fs.readFileSync(recentFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.recent;
    if (Array.isArray(list)) {
      // Drop folders that no longer exist so the list never shows dead entries.
      state.recent = list.filter((entry) => typeof entry === 'string' && fs.existsSync(entry));
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed.current === 'string') {
      if (fs.existsSync(parsed.current)) state.projectRoot = parsed.current;
    }
  } catch {
    state.recent = [];
  }
}

function saveRecent() {
  try {
    fs.mkdirSync(path.dirname(recentFilePath()), { recursive: true });
    const payload = { recent: state.recent, current: state.projectRoot };
    fs.writeFileSync(recentFilePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* non fatal */
  }
}

function pushRecent(projectPath) {
  state.recent = [projectPath, ...state.recent.filter((p) => p !== projectPath)].slice(0, 10);
  saveRecent();
}

/* ------------------------------------------------------------------ *
 * IPC surface
 * ------------------------------------------------------------------ */

function registerIpc() {
  /* ---------------- filesystem ---------------- */

  ipcMain.handle('fs:list', async (_event, dirPath) => {
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        let size = 0;
        let mtimeMs = 0;
        if (entry.isFile()) {
          try {
            const st = await fsp.stat(full);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            /* ignore unreadable entries */
          }
        }
        out.push({
          name: entry.name,
          path: full,
          isDirectory: entry.isDirectory(),
          size,
          mtimeMs,
        });
      }
      out.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, 'tr', { numeric: true, sensitivity: 'base' });
      });
      return ok(out);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:read', async (_event, filePath) => {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) throw new Error('This is a folder, not a file.');
      const content = await fsp.readFile(filePath, 'utf8');
      return ok({ content, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:write', async (_event, filePath, content) => {
    try {
      await fsp.writeFile(filePath, content, 'utf8');
      const stat = await fsp.stat(filePath);
      return ok({ mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:createFile', async (_event, dirPath, name) => {
    try {
      const safeName = validateName(name);
      const target = path.join(dirPath, safeName);
      if (fs.existsSync(target)) throw new Error(`"${safeName}" already exists.`);
      await fsp.writeFile(target, '', 'utf8');
      return ok({ path: target, name: safeName });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:createFolder', async (_event, dirPath, name) => {
    try {
      const safeName = validateName(name);
      const target = path.join(dirPath, safeName);
      if (fs.existsSync(target)) throw new Error(`"${safeName}" already exists.`);
      await fsp.mkdir(target, { recursive: false });
      return ok({ path: target, name: safeName });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:rename', async (_event, fromPath, toPath) => {
    try {
      if (fs.existsSync(toPath)) throw new Error('A file with that name already exists.');
      await fsp.rename(fromPath, toPath);
      return ok({ path: toPath });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:remove', async (_event, targetPath) => {
    try {
      await fsp.rm(targetPath, { recursive: true, force: false });
      return ok({ path: targetPath });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('fs:exists', async (_event, targetPath) => {
    try {
      return ok(fs.existsSync(targetPath));
    } catch (err) {
      return fail(err);
    }
  });

  /* ---------------- project ---------------- */

  ipcMain.handle('project:open', async () => {
    const win = state.mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Project Folder',
      properties: ['openDirectory'],
      buttonLabel: 'Open Project',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return ok({ canceled: true });
    }
    const projectPath = result.filePaths[0];
    state.projectRoot = projectPath;
    pushRecent(projectPath);
    return ok({
      canceled: false,
      path: projectPath,
      name: path.basename(projectPath),
    });
  });

  ipcMain.handle('project:setRoot', async (_event, projectPath) => {
    state.projectRoot = projectPath;
    if (projectPath) pushRecent(projectPath);
    return ok({ path: state.projectRoot });
  });

  ipcMain.handle('project:getRoot', async () => ok({ path: state.projectRoot }));
  ipcMain.handle('project:recent', async () => ok(state.recent));

  ipcMain.handle('project:removeRecent', async (_event, projectPath) => {
    state.recent = state.recent.filter((p) => p !== projectPath);
    saveRecent();
    return ok(state.recent);
  });

  /* ---------------- terminal ---------------- */

  ipcMain.handle('terminal:start', async (_event, kind, cwd) => {
    try {
      return ok(startShellSession(kind, cwd));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('terminal:write', async (_event, id, data) => ok(writeToShell(id, data)));
  ipcMain.handle('terminal:kill', async (_event, id) => ok(killShell(id)));

  /* ---------------- run ---------------- */

  ipcMain.handle('process:runJs', async (_event, filePath, cwd) => {
    if (!state.nodeInfo.available) {
      return fail(
        new Error(
          'Node.js was not found on this computer. Install Node.js (https://nodejs.org) and try again.',
        ),
      );
    }
    try {
      return ok(startRunSession(filePath, cwd));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('process:kill', async (_event, id) => ok(killRun(id)));
  ipcMain.handle('process:nodeInfo', async () => ok(state.nodeInfo));

  /* ---------------- preview ---------------- */

  ipcMain.handle('preview:open', async (_event, filePath) => {
    try {
      createPreviewWindow(filePath);
      return ok(true);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('preview:close', async () => {
    if (state.previewWindow && !state.previewWindow.isDestroyed()) state.previewWindow.close();
    return ok(true);
  });

  ipcMain.handle('preview:reload', async () => {
    if (state.previewWindow && !state.previewWindow.isDestroyed()) {
      state.previewWindow.reload();
    }
    return ok(true);
  });

  ipcMain.handle('preview:isOpen', async () =>
    ok(Boolean(state.previewWindow && !state.previewWindow.isDestroyed())),
  );

  /* ---------------- window ---------------- */

  ipcMain.handle('window:minimize', async () => {
    state.mainWindow?.minimize();
    return ok(true);
  });

  ipcMain.handle('window:toggleMaximize', async () => {
    const win = state.mainWindow;
    if (!win) return ok(false);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return ok(win.isMaximized());
  });

  ipcMain.handle('window:close', async () => {
    state.mainWindow?.close();
    return ok(true);
  });

  ipcMain.handle('window:isMaximized', async () => ok(Boolean(state.mainWindow?.isMaximized())));

  /* ---------------- app ---------------- */

  ipcMain.handle('app:info', async () =>
    ok({
      name: 'Codes',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${os.type()} ${os.release()}`,
      osName: detectWindowsName(),
      appRoot: APP_ROOT,
    }),
  );

  ipcMain.handle('app:openExternal', async (_event, url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    return ok(true);
  });

  ipcMain.handle('app:openInExplorer', async (_event, targetPath) => {
    shell.showItemInFolder(targetPath);
    return ok(true);
  });
}

function validateName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Please enter a name.');
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error('The name contains characters that are not allowed on Windows.');
  }
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name.');
  return trimmed;
}

function detectWindowsName() {
  const release = os.release();
  const major = parseInt(release.split('.')[0], 10);
  if (major >= 13) return 'Windows 11';
  if (major >= 10) return 'Windows 10';
  return `Windows ${major}`;
}

/* ------------------------------------------------------------------ *
 * Menu
 * ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: 'Codes',
      submenu: [
        { label: 'About Codes', click: () => sendToRenderer('menu:command', 'app.about') },
        { type: 'separator' },
        { label: 'Reload Interface', accelerator: 'CmdOrCtrl+R', click: () => state.mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu:command', 'file.newFile') },
        { label: 'Open Project...', accelerator: 'CmdOrCtrl+O', click: () => sendToRenderer('menu:command', 'project.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('menu:command', 'file.save') },
        { label: 'Save All', click: () => sendToRenderer('menu:command', 'file.saveAll') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendToRenderer('menu:command', 'file.closeTab') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendToRenderer('menu:command', 'edit.undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => sendToRenderer('menu:command', 'edit.redo') },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendToRenderer('menu:command', 'edit.find') },
      ],
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run JavaScript File', accelerator: 'F5', click: () => sendToRenderer('menu:command', 'run.runJs') },
        { label: 'Stop', click: () => sendToRenderer('menu:command', 'run.stop') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette...', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendToRenderer('menu:command', 'view.palette') },
        { label: 'Quick Open...', accelerator: 'CmdOrCtrl+P', click: () => sendToRenderer('menu:command', 'view.quickOpen') },
        { type: 'separator' },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => sendToRenderer('menu:command', 'terminal.toggle') },
        { label: 'Toggle Explorer', click: () => sendToRenderer('menu:command', 'view.toggleSidebar') },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'F12', click: () => state.mainWindow?.webContents.toggleDevTools() },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

function detectNode() {
  return new Promise((resolve) => {
    try {
      const result = spawn('node', ['--version'], { windowsHide: true });
      let out = '';
      result.stdout.on('data', (d) => {
        out += d.toString();
      });
      result.on('error', () => {
        state.nodeInfo = { available: false, version: null };
        resolve(state.nodeInfo);
      });
      result.on('close', () => {
        const version = out.trim();
        state.nodeInfo = { available: Boolean(version), version: version || null };
        resolve(state.nodeInfo);
      });
    } catch {
      state.nodeInfo = { available: false, version: null };
      resolve(state.nodeInfo);
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = state.mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    loadRecent();
    await detectNode();
    registerProtocols();
    registerIpc();
    buildMenu();

    state.mainWindow = createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        state.mainWindow = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', shutdownSessions);
}

module.exports = { SHELLS, safeResolve, detectWindowsName };
