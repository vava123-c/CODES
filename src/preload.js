'use strict';

/**
 * Codes 0.2 - preload bridge.
 *
 * The renderer runs sandboxed (contextIsolation: true, nodeIntegration: false),
 * so this file is the only bridge between the UI and the operating system.
 * Every method below maps to one explicit IPC channel; nothing else is exposed.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap an IPC channel so the renderer always receives { ok, data | error }. */
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || typeof result !== 'object') {
    return { ok: false, error: `Unexpected response from "${channel}".` };
  }
  return result;
}

/** Subscribe to a push channel and return a disposer function. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('codesAPI', {
  fs: {
    list: (dirPath) => invoke('fs:list', dirPath),
    read: (filePath) => invoke('fs:read', filePath),
    write: (filePath, content) => invoke('fs:write', filePath, content),
    createFile: (dirPath, name) => invoke('fs:createFile', dirPath, name),
    createFolder: (dirPath, name) => invoke('fs:createFolder', dirPath, name),
    rename: (fromPath, toPath) => invoke('fs:rename', fromPath, toPath),
    remove: (targetPath) => invoke('fs:remove', targetPath),
    exists: (targetPath) => invoke('fs:exists', targetPath),
  },

  project: {
    open: () => invoke('project:open'),
    setRoot: (projectPath) => invoke('project:setRoot', projectPath),
    getRoot: () => invoke('project:getRoot'),
    recent: () => invoke('project:recent'),
    removeRecent: (projectPath) => invoke('project:removeRecent', projectPath),
  },

  terminal: {
    start: (kind, cwd) => invoke('terminal:start', kind, cwd),
    write: (id, data) => invoke('terminal:write', id, data),
    kill: (id) => invoke('terminal:kill', id),
    onOutput: (callback) => subscribe('terminal:output', callback),
    onExit: (callback) => subscribe('terminal:exit', callback),
  },

  process: {
    runJs: (filePath, cwd) => invoke('process:runJs', filePath, cwd),
    kill: (id) => invoke('process:kill', id),
    nodeInfo: () => invoke('process:nodeInfo'),
  },

  preview: {
    open: (filePath) => invoke('preview:open', filePath),
    close: () => invoke('preview:close'),
    reload: () => invoke('preview:reload'),
    isOpen: () => invoke('preview:isOpen'),
  },

  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
  },

  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url),
    openInExplorer: (targetPath) => invoke('app:openInExplorer', targetPath),
    onMenuCommand: (callback) => subscribe('menu:command', callback),
  },
});
