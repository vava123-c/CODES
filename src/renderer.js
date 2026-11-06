/**
 * Codes 0.2 - Renderer.
 *
 * The application shell: owns the state (open files, active tab, project),
 * wires the editor, explorer, tabs, terminal and preview together and turns
 * every user action into a command.
 */

import { createEditor, languageFor } from './editor.js';
import { createTabs } from './tabs.js';
import { createExplorer } from './explorer.js';
import { createTerminals } from './terminal.js';
import { createPreview, isPreviewable } from './preview.js';
import { createCommandRegistry, createPalette, createContextMenu } from './commands.js';

const api = window.codesAPI;

/* ------------------------------------------------------------------ *
 * DOM references
 * ------------------------------------------------------------------ */

const dom = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  sidebarProject: document.getElementById('sidebar-project'),
  explorer: document.getElementById('explorer'),
  main: document.getElementById('main'),
  tabs: document.getElementById('tabs'),
  tabsList: document.getElementById('tabs-list'),
  editorHost: document.getElementById('editor-host'),
  editorArea: document.getElementById('editor-area'),
  welcome: document.getElementById('welcome'),
  welcomeRecent: document.getElementById('welcome-recent'),
  welcomeRecentSection: document.getElementById('welcome-recent-section'),
  terminalPanel: document.getElementById('terminal-panel'),
  terminalHost: document.getElementById('terminal-host'),
  terminalTabs: document.getElementById('terminal-tabs'),
  statusMessage: document.getElementById('status-message'),
  statusLanguage: document.getElementById('status-language'),
  statusEol: document.getElementById('status-eol'),
  statusPosition: document.getElementById('status-position'),
  statusSelection: document.getElementById('status-selection'),
  statusProject: document.getElementById('status-project'),
  statusShell: document.getElementById('status-shell'),
  osBadge: document.getElementById('os-badge'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('palette-input'),
  paletteList: document.getElementById('palette-list'),
  contextMenu: document.getElementById('context-menu'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  modalMessage: document.getElementById('modal-message'),
  modalInput: document.getElementById('modal-input'),
  modalConfirm: document.getElementById('modal-confirm'),
  modalCancel: document.getElementById('modal-cancel'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  toasts: document.getElementById('toasts'),
  menubar: document.getElementById('menubar'),
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  /** @type {Map<string, {path: string, name: string, languageId: string, languageLabel: string, state: any, dirty: boolean}>} */
  files: new Map(),
  /** @type {string[]} ordered list of open file paths */
  order: [],
  activePath: null,
  projectRoot: null,
  projectName: '',
  terminalVisible: true,
};

/* ------------------------------------------------------------------ *
 * Toasts & dialogs
 * ------------------------------------------------------------------ */

const ICONS = { info: 'i-info', error: 'i-error', warning: 'i-warning', success: 'i-check' };

function toast(message, type = 'info', title = '') {
  const element = document.createElement('div');
  element.className = `toast toast--${type}`;

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${ICONS[type] || ICONS.info}`);
  icon.appendChild(use);
  element.appendChild(icon);

  const text = document.createElement('div');
  text.className = 'toast__text';
  if (title) {
    const heading = document.createElement('div');
    heading.className = 'toast__title';
    heading.textContent = title;
    text.appendChild(heading);
  }
  text.appendChild(document.createTextNode(message));
  element.appendChild(text);

  dom.toasts.appendChild(element);
  setTimeout(() => {
    element.style.opacity = '0';
    element.style.transition = 'opacity 160ms ease';
    setTimeout(() => element.remove(), 200);
  }, type === 'error' ? 6500 : 3800);
}

/**
 * Show a modal dialog.
 * @param {{title: string, message?: string, value?: string, placeholder?: string, confirmLabel?: string, danger?: boolean}} options
 * @returns {Promise<string|boolean|null>}
 */
function showDialog(options) {
  return new Promise((resolve) => {
    dom.modalTitle.textContent = options.title;
    dom.modalMessage.textContent = options.message || '';
    dom.modalMessage.style.display = options.message ? 'block' : 'none';
    dom.modalConfirm.textContent = options.confirmLabel || 'Confirm';
    dom.modalConfirm.classList.toggle('button--danger', Boolean(options.danger));
    dom.modalConfirm.classList.toggle('button--primary', !options.danger);

    const wantsInput = typeof options.value === 'string';
    dom.modalInput.classList.toggle('modal__input--visible', wantsInput);
    dom.modalInput.value = wantsInput ? options.value : '';
    dom.modalInput.placeholder = options.placeholder || '';
    dom.modal.hidden = false;

    if (wantsInput) {
      requestAnimationFrame(() => {
        dom.modalInput.focus();
        dom.modalInput.select();
      });
    } else {
      requestAnimationFrame(() => dom.modalConfirm.focus());
    }

    const cleanup = (result) => {
      dom.modal.hidden = true;
      dom.modalConfirm.removeEventListener('click', onConfirm);
      dom.modalCancel.removeEventListener('click', onCancel);
      dom.modalBackdrop.removeEventListener('click', onCancel);
      dom.modalInput.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keydown', onEscape, true);
      resolve(result);
    };

    const onConfirm = () => cleanup(wantsInput ? dom.modalInput.value.trim() : true);
    const onCancel = () => cleanup(null);
    const onKeyDown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onConfirm();
      }
    };
    const onEscape = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(null);
      }
    };

    dom.modalConfirm.addEventListener('click', onConfirm);
    dom.modalCancel.addEventListener('click', onCancel);
    dom.modalBackdrop.addEventListener('click', onCancel);
    dom.modalInput.addEventListener('keydown', onKeyDown);
    document.addEventListener('keydown', onEscape, true);
  });
}

const confirmDialog = (title, message, options = {}) =>
  showDialog({ title, message, ...options });

const promptDialog = (title, message, value = '', options = {}) =>
  showDialog({ title, message, value, ...options });

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

const editor = createEditor({
  parent: dom.editorHost,
  onCommand: (id) => commands.execute(id),
  onStateChange: (editorState) => {
    const file = currentFile();
    if (!file) return;
    file.state = editorState;
    if (!file.dirty) {
      file.dirty = true;
      renderTabs();
      renderStatus();
    }
  },
  onCursor: (info) => {
    dom.statusPosition.textContent = `Ln ${info.line}, Col ${info.column}`;
    dom.statusSelection.textContent = info.selected > 0 ? `${info.selected} selected` : '';
  },
});

function currentFile() {
  return state.activePath ? state.files.get(state.activePath) : null;
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const tabs = createTabs({
  container: dom.tabsList,
  onActivate: (path) => activateFile(path),
  onClose: (path) => closeFile(path),
});

function renderTabs() {
  const list = state.order
    .map((path) => state.files.get(path))
    .filter(Boolean)
    .map((file) => ({
      path: file.path,
      name: file.name,
      languageId: file.languageId,
      dirty: file.dirty,
    }));
  tabs.render(list, state.activePath);
}

/* ------------------------------------------------------------------ *
 * Explorer
 * ------------------------------------------------------------------ */

const explorer = createExplorer({
  container: dom.explorer,
  api,
  onOpenFile: (path) => openFile(path),
  onError: (message) => toast(message, 'error', 'Explorer'),
  onRefresh: () => setStatus('Explorer refreshed'),
});

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

const terminals = createTerminals({
  host: dom.terminalHost,
  api,
  onStatus: () => renderStatus(),
  onError: (message) => toast(message, 'error', 'Terminal'),
});

/* ------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------ */

const preview = createPreview({
  api,
  onStatus: () => renderStatus(),
  onError: (message) => toast(message, 'error', 'Preview'),
});

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

const commands = createCommandRegistry();

commands
  .register({
    id: 'project.open',
    title: 'Open Project',
    category: 'Project',
    shortcut: 'Ctrl+O',
    run: openProject,
  })
  .register({
    id: 'project.close',
    title: 'Close Project',
    category: 'Project',
    run: closeProject,
  })
  .register({
    id: 'explorer.refresh',
    title: 'Refresh Explorer',
    category: 'Project',
    run: () => {
      explorer.refresh();
      setStatus('Explorer refreshed');
    },
  })
  .register({
    id: 'file.newFile',
    title: 'New File',
    category: 'File',
    shortcut: 'Ctrl+N',
    run: newFile,
  })
  .register({
    id: 'file.newFolder',
    title: 'New Folder',
    category: 'File',
    run: newFolder,
  })
  .register({
    id: 'file.save',
    title: 'Save File',
    category: 'File',
    shortcut: 'Ctrl+S',
    run: () => saveActiveFile(),
  })
  .register({
    id: 'file.saveAll',
    title: 'Save All',
    category: 'File',
    run: () => saveAllFiles(),
  })
  .register({
    id: 'file.closeTab',
    title: 'Close Tab',
    category: 'File',
    shortcut: 'Ctrl+W',
    run: () => (state.activePath ? closeFile(state.activePath) : undefined),
  })
  .register({
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    shortcut: 'Ctrl+Z',
    run: () => editor.undo(),
  })
  .register({
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    shortcut: 'Ctrl+Y',
    run: () => editor.redo(),
  })
  .register({
    id: 'edit.find',
    title: 'Find in File',
    category: 'Edit',
    shortcut: 'Ctrl+Shift+F',
    run: () => editor.openSearch(),
  })
  .register({
    id: 'run.runJs',
    title: 'Run JavaScript File',
    category: 'Run',
    shortcut: 'F5',
    run: runActiveFile,
  })
  .register({
    id: 'run.stop',
    title: 'Stop Running Process',
    category: 'Run',
    run: stopProcess,
  })
  .register({
    id: 'terminal.toggle',
    title: 'Toggle Terminal',
    category: 'View',
    shortcut: 'Ctrl+`',
    run: toggleTerminal,
  })
  .register({
    id: 'terminal.open',
    title: 'Open Terminal',
    category: 'View',
    run: () => {
      showTerminal();
      setStatus('Terminal opened');
    },
  })
  .register({
    id: 'terminal.cmd',
    title: 'Switch to CMD',
    category: 'View',
    run: () => switchShell('cmd'),
  })
  .register({
    id: 'terminal.powershell',
    title: 'Switch to PowerShell',
    category: 'View',
    run: () => switchShell('powershell'),
  })
  .register({
    id: 'terminal.clear',
    title: 'Clear Terminal',
    category: 'View',
    run: () => terminals.clear(),
  })
  .register({
    id: 'preview.open',
    title: 'Preview HTML File',
    category: 'View',
    run: openPreview,
  })
  .register({
    id: 'view.palette',
    title: 'Command Palette',
    category: 'View',
    shortcut: 'Ctrl+Shift+P',
    run: () => palette.show('command'),
  })
  .register({
    id: 'view.quickOpen',
    title: 'Quick Open',
    category: 'View',
    shortcut: 'Ctrl+P',
    run: () => palette.show('file'),
  })
  .register({
    id: 'view.toggleSidebar',
    title: 'Toggle Explorer',
    category: 'View',
    run: toggleSidebar,
  })
  .register({
    id: 'app.about',
    title: 'About Codes',
    category: 'Help',
    run: showAbout,
  });

/* ------------------------------------------------------------------ *
 * Palette & context menu
 * ------------------------------------------------------------------ */

let quickFiles = [];

const palette = createPalette({
  root: dom.palette,
  input: dom.paletteInput,
  list: dom.paletteList,
  getItems: (mode) => {
    if (mode === 'file') {
      return quickFiles.map((file) => ({
        id: file.path,
        label: file.path,
        detail: file.name,
        icon: 'i-file',
      }));
    }
    return commands.list().map((command) => ({
      id: command.id,
      label: command.title,
      detail: command.category,
      shortcut: command.shortcut,
      icon: 'i-terminal',
    }));
  },
  onSelect: (id, item) => {
    if (item && item.detail && !commands.get(id)) {
      openFile(id);
      return;
    }
    commands.execute(id);
  },
});

const contextMenu = createContextMenu({ element: dom.contextMenu });

/* ------------------------------------------------------------------ *
 * Application actions
 * ------------------------------------------------------------------ */

async function openProject() {
  const response = await api.project.open();
  if (!response.ok) {
    toast(response.error, 'error', 'Project');
    return;
  }
  if (response.data.canceled) return;
  await applyProject(response.data.path, response.data.name);
}

async function applyProject(projectPath, projectName) {
  state.projectRoot = projectPath;
  state.projectName = projectName || projectPath.split(/[\\/]/).filter(Boolean).pop();

  await api.project.setRoot(projectPath);
  terminals.setProjectRoot(projectPath);

  dom.sidebarProject.textContent = state.projectName;
  dom.statusProject.textContent = state.projectName;

  await explorer.setRoot(projectPath, state.projectName);
  await renderRecentProjects();
  await scanProjectFiles();

  setStatus(`Opened ${state.projectName}`);
  toast(`Project "${state.projectName}" is ready`, 'success');
}

async function closeProject() {
  if (!state.projectRoot) return;
  const confirmed = await confirmDialog(
    'Close project',
    'All open files will be closed. Unsaved changes will be lost.',
    { confirmLabel: 'Close project', danger: true },
  );
  if (!confirmed) return;

  for (const path of [...state.order]) {
    state.files.delete(path);
  }
  state.order = [];
  state.activePath = null;
  editor.setState(editor.createState('', 'plaintext'));

  state.projectRoot = null;
  state.projectName = '';
  dom.sidebarProject.textContent = '';
  dom.statusProject.textContent = 'No Project';

  explorer.setRoot(null);
  renderTabs();
  updateWelcomeVisibility();
  setStatus('Project closed');
}

async function newFile() {
  if (!state.projectRoot) {
    const confirmed = await confirmDialog('No project open', 'Open a project first?', {
      confirmLabel: 'Open Project',
    });
    if (confirmed) await openProject();
    return;
  }

  const name = await promptDialog('New file', 'File name (relative to the project root):', '', {
    placeholder: 'src/app.js',
  });
  if (!name) return;

  const target = name.includes('\\') || name.includes('/')
    ? name
    : `${state.projectRoot}\\${name}`;

  const response = await api.fs.createFile(state.projectRoot, target.replace(/\\/g, '/'));
  if (!response.ok) {
    toast(response.error, 'error', 'New file');
    return;
  }
  explorer.refresh();
  await openFile(response.data.path);
}

async function newFolder() {
  if (!state.projectRoot) {
    toast('Open a project first.', 'warning');
    return;
  }
  const name = await promptDialog('New folder', 'Folder name:', '', {
    placeholder: 'components',
  });
  if (!name) return;

  const response = await api.fs.createFolder(state.projectRoot, name);
  if (!response.ok) {
    toast(response.error, 'error', 'New folder');
    return;
  }
  explorer.refresh();
  setStatus(`Created ${name}`);
}

async function openFile(filePath) {
  const existing = state.files.get(filePath);
  if (existing) {
    activateFile(filePath);
    return;
  }

  const response = await api.fs.read(filePath);
  if (!response.ok) {
    toast(response.error, 'error', 'Open file');
    return;
  }

  const name = filePath.split(/[\\/]/).filter(Boolean).pop();
  const language = languageFor(filePath);
  const editorState = editor.createState(response.data.content, language.id);

  state.files.set(filePath, {
    path: filePath,
    name,
    languageId: language.id,
    languageLabel: language.label,
    state: editorState,
    dirty: false,
  });
  state.order.push(filePath);

  activateFile(filePath);
  setStatus(`Opened ${name}`);
}

function activateFile(filePath) {
  const file = state.files.get(filePath);
  if (!file) return;

  state.activePath = filePath;
  editor.setState(file.state);
  editor.focus();

  renderTabs();
  explorer.setActivePath(filePath);
  updateWelcomeVisibility();
  renderStatus();
}

async function closeFile(filePath) {
  const file = state.files.get(filePath);
  if (!file) return;

  if (file.dirty) {
    const save = await confirmDialog(
      'Unsaved changes',
      `"${file.name}" has unsaved changes. Save before closing?`,
      { confirmLabel: 'Save and close' },
    );
    if (save) {
      await saveFile(file);
    } else {
      const discard = await confirmDialog('Discard changes?', 'The changes will be lost.', {
        confirmLabel: 'Discard changes',
        danger: true,
      });
      if (!discard) return;
    }
  }

  state.files.delete(filePath);
  state.order = state.order.filter((entry) => entry !== filePath);

  if (state.activePath === filePath) {
    const next = state.order[state.order.length - 1] || null;
    state.activePath = null;
    if (next) {
      activateFile(next);
    } else {
      editor.setState(editor.createState('', 'plaintext'));
      updateWelcomeVisibility();
      renderStatus();
    }
  }

  renderTabs();
  explorer.setActivePath(state.activePath);
}

async function saveActiveFile() {
  const file = currentFile();
  if (!file) return;
  await saveFile(file);
}

async function saveFile(file) {
  const content = file.state.doc.toString();
  const response = await api.fs.write(file.path, content);
  if (!response.ok) {
    toast(response.error, 'error', 'Save');
    setStatus('Save failed', 'error');
    return false;
  }
  file.dirty = false;
  renderTabs();
  setStatus(`Saved ${file.name}`, 'success');

  if (preview.isOpen && preview.file === file.path) {
    await preview.reload();
  }
  return true;
}

async function saveAllFiles() {
  let saved = 0;
  for (const file of state.files.values()) {
    if (file.dirty) {
      const ok = await saveFile(file);
      if (ok) saved += 1;
    }
  }
  setStatus(saved > 0 ? `Saved ${saved} file(s)` : 'Nothing to save', 'success');
}

async function runActiveFile() {
  const file = currentFile();
  if (!file) {
    toast('Open a JavaScript file first.', 'warning');
    return;
  }

  const isJavaScript = /\.(js|mjs|cjs)$/i.test(file.path);
  if (!isJavaScript) {
    toast('Only JavaScript files can be run.', 'warning');
    return;
  }

  if (file.dirty) await saveFile(file);

  setStatus('Running…', 'busy');
  showTerminal();

  const response = await api.process.runJs(file.path, state.projectRoot || undefined);
  if (!response.ok) {
    toast(response.error, 'error', 'Run');
    setStatus('Run failed', 'error');
    return;
  }

  terminals.attachRun(response.data.id);
  setStatus(`Running ${file.name}`, 'busy');
}

async function stopProcess() {
  const stopped = await terminals.stop();
  if (!stopped) {
    toast('No running process in this terminal.', 'info');
  } else {
    setStatus('Process stopped', 'success');
  }
}

function showTerminal() {
  state.terminalVisible = true;
  dom.main.classList.remove('main--terminal-hidden');
  terminals.setVisible(true);
}

function toggleTerminal() {
  state.terminalVisible = !state.terminalVisible;
  dom.main.classList.toggle('main--terminal-hidden', !state.terminalVisible);
  terminals.setVisible(state.terminalVisible);
  setStatus(state.terminalVisible ? 'Terminal shown' : 'Terminal hidden');
}

async function switchShell(kind) {
  showTerminal();
  await terminals.activate(kind);
  renderTerminalTabs();
}

function toggleSidebar() {
  const hidden = dom.sidebar.classList.toggle('sidebar--hidden');
  dom.app.style.setProperty('--sidebar-w', hidden ? '0px' : '248px');
  setStatus(hidden ? 'Explorer hidden' : 'Explorer shown');
}

async function openPreview() {
  const file = currentFile();
  if (!file) {
    toast('Open an HTML file first.', 'warning');
    return;
  }
  if (!isPreviewable(file.path)) {
    toast('Preview is only available for HTML files.', 'warning');
    return;
  }
  await preview.toggle(file.path);
  setStatus(preview.isOpen ? 'Preview opened' : 'Preview closed');
}

async function showAbout() {
  const info = await api.app.info();
  if (!info.ok) {
    toast(info.error, 'error');
    return;
  }
  await confirmDialog(
    'Codes 0.2',
    `Codes ${info.data.version} — Lightweight Development Environment\n` +
      `Electron ${info.data.electron} · Chromium ${info.data.chrome} · Node ${info.data.node}\n${info.data.osName}`,
    { confirmLabel: 'Close' },
  );
}

/* ------------------------------------------------------------------ *
 * Status bar
 * ------------------------------------------------------------------ */

let statusTimer = null;

function setStatus(message, kind = 'ready') {
  dom.statusMessage.textContent = message;
  dom.statusMessage.className = `status status--${kind}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    dom.statusMessage.textContent = 'Ready';
    dom.statusMessage.className = 'status status--ready';
  }, 4000);
}

function renderStatus() {
  const file = currentFile();
  dom.statusLanguage.textContent = file ? file.languageLabel : 'Plain Text';

  const content = file ? file.state.doc.toString() : '';
  dom.statusEol.textContent = content.includes('\r\n') ? 'CRLF' : 'LF';

  dom.statusShell.textContent = terminals.activeKind === 'powershell' ? 'PowerShell' : 'CMD';
  renderTerminalTabs();
}

function updateWelcomeVisibility() {
  const show = state.order.length === 0;
  dom.welcome.classList.toggle('welcome--hidden', !show);
  dom.tabs.classList.toggle('tabs--empty', show);
}

async function renderRecentProjects() {
  const response = await api.project.recent();
  if (!response.ok) return;

  dom.welcomeRecent.textContent = '';
  const items = response.data.filter((entry) => entry !== state.projectRoot);

  if (items.length === 0) {
    dom.welcomeRecentSection.style.display = 'none';
    return;
  }
  dom.welcomeRecentSection.style.display = '';

  for (const projectPath of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-item';

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-folder');
    icon.appendChild(use);
    item.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = projectPath.split(/[\\/]/).filter(Boolean).pop();
    item.appendChild(label);

    const path = document.createElement('span');
    path.className = 'recent-item__path';
    path.textContent = projectPath;
    item.appendChild(path);

    const remove = document.createElement('span');
    remove.className = 'recent-item__remove';
    remove.title = 'Remove from list';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      await api.project.removeRecent(projectPath);
      renderRecentProjects();
    });
    const removeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const removeUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    removeUse.setAttribute('href', '#i-close');
    removeIcon.appendChild(removeUse);
    remove.appendChild(removeIcon);
    item.appendChild(remove);

    item.addEventListener('click', async () => {
      await applyProject(projectPath, projectPath.split(/[\\/]/).filter(Boolean).pop());
    });

    dom.welcomeRecent.appendChild(item);
  }
}

/** Collect the project files so that Quick Open can search them. */
async function scanProjectFiles() {
  quickFiles = [];
  if (!state.projectRoot) return;

  const results = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

  async function walk(dir, depth) {
    if (depth > 8 || results.length > 3000) return;
    const response = await api.fs.list(dir);
    if (!response.ok) return;
    for (const entry of response.data) {
      if (skip.has(entry.name)) continue;
      if (entry.isDirectory) {
        await walk(entry.path, depth + 1);
      } else {
        results.push(entry.path);
        if (results.length > 3000) return;
      }
    }
  }

  await walk(state.projectRoot, 0);
  quickFiles = results;
}

/* ------------------------------------------------------------------ *
 * Terminal tabs
 * ------------------------------------------------------------------ */

function renderTerminalTabs() {
  dom.terminalTabs.textContent = '';
  for (const kind of ['cmd', 'powershell']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shell-tab';
    if (kind === terminals.activeKind) button.classList.add('shell-tab--active');

    const dot = document.createElement('span');
    dot.className = 'shell-tab__dot';
    if (kind === terminals.activeKind) dot.classList.add('shell-tab__dot--busy');
    button.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = kind === 'powershell' ? 'PowerShell' : 'CMD';
    button.appendChild(label);

    button.addEventListener('click', () => switchShell(kind));
    dom.terminalTabs.appendChild(button);
  }
}

/* ------------------------------------------------------------------ *
 * Menu bar
 * ------------------------------------------------------------------ */

const MENUS = {
  project: [
    { label: 'Open Project…', shortcut: 'Ctrl+O', command: 'project.open' },
    { label: 'Close Project', command: 'project.close' },
    { separator: true },
    { label: 'New File', shortcut: 'Ctrl+N', command: 'file.newFile' },
    { label: 'New Folder', command: 'file.newFolder' },
    { separator: true },
    { label: 'Refresh Explorer', command: 'explorer.refresh' },
  ],
  file: [
    { label: 'Save', shortcut: 'Ctrl+S', command: 'file.save' },
    { label: 'Save All', command: 'file.saveAll' },
    { separator: true },
    { label: 'Close Tab', shortcut: 'Ctrl+W', command: 'file.closeTab' },
    { separator: true },
    { label: 'Preview HTML', command: 'preview.open' },
  ],
  edit: [
    { label: 'Undo', shortcut: 'Ctrl+Z', command: 'edit.undo' },
    { label: 'Redo', shortcut: 'Ctrl+Y', command: 'edit.redo' },
    { separator: true },
    { label: 'Find in File', shortcut: 'Ctrl+Shift+F', command: 'edit.find' },
  ],
  run: [
    { label: 'Run JavaScript File', shortcut: 'F5', command: 'run.runJs' },
    { label: 'Stop Running Process', command: 'run.stop' },
  ],
  view: [
    { label: 'Command Palette…', shortcut: 'Ctrl+Shift+P', command: 'view.palette' },
    { label: 'Quick Open…', shortcut: 'Ctrl+P', command: 'view.quickOpen' },
    { separator: true },
    { label: 'Toggle Terminal', shortcut: 'Ctrl+`', command: 'terminal.toggle' },
    { label: 'Switch to CMD', command: 'terminal.cmd' },
    { label: 'Switch to PowerShell', command: 'terminal.powershell' },
    { label: 'Clear Terminal', command: 'terminal.clear' },
    { separator: true },
    { label: 'Toggle Explorer', command: 'view.toggleSidebar' },
  ],
  help: [
    { label: 'About Codes', command: 'app.about' },
  ],
};

let openMenu = null;

function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
  for (const item of dom.menubar.querySelectorAll('.menubar__item')) {
    item.classList.remove('menubar__item--open');
  }
}

function showMenu(anchor, items) {
  closeMenu();
  anchor.classList.add('menubar__item--open');

  const menu = document.createElement('div');
  menu.className = 'contextmenu';
  menu.style.minWidth = '210px';

  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'contextmenu__sep';
      menu.appendChild(separator);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'contextmenu__item';
    const label = document.createElement('span');
    label.textContent = item.label;
    button.appendChild(label);
    if (item.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'contextmenu__shortcut';
      shortcut.textContent = item.shortcut;
      button.appendChild(shortcut);
    }
    button.addEventListener('click', () => {
      closeMenu();
      commands.execute(item.command);
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  openMenu = menu;

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
}

dom.menubar.addEventListener('click', (event) => {
  const item = event.target.closest('.menubar__item');
  if (!item) return;
  const key = item.dataset.menu;
  if (openMenu && item.classList.contains('menubar__item--open')) {
    closeMenu();
    return;
  }
  showMenu(item, MENUS[key] || []);
});

document.addEventListener('mousedown', (event) => {
  if (openMenu && !openMenu.contains(event.target) && !event.target.closest('.menubar__item')) {
    closeMenu();
  }
});

/* ------------------------------------------------------------------ *
 * Explorer context menu
 * ------------------------------------------------------------------ */

dom.explorer.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('.tree-row');
  if (!row) {
    event.preventDefault();
    return;
  }
  const node = explorer.findNode(explorer.root, row.dataset.path);
  if (!node) return;

  event.preventDefault();

  const items = node.isDirectory
    ? [
        { label: 'Open', icon: 'i-folder-open', onSelect: () => {} },
        { label: 'New File', icon: 'i-new-file', shortcut: 'Ctrl+N', onSelect: () => newFileIn(node.path) },
        { label: 'New Folder', icon: 'i-new-folder', onSelect: () => newFolderIn(node.path) },
        { separator: true },
        { label: 'Rename', icon: 'i-rename', onSelect: () => renameNode(node) },
        { label: 'Delete', icon: 'i-trash', danger: true, onSelect: () => deleteNode(node) },
        { separator: true },
        { label: 'Refresh', icon: 'i-refresh', onSelect: () => explorer.refresh() },
      ]
    : [
        { label: 'Open', icon: 'i-file', onSelect: () => openFile(node.path) },
        { separator: true },
        { label: 'Rename', icon: 'i-rename', onSelect: () => renameNode(node) },
        { label: 'Delete', icon: 'i-trash', danger: true, onSelect: () => deleteNode(node) },
        { separator: true },
        { label: 'Show in Explorer', icon: 'i-folder', onSelect: () => api.app.openInExplorer(node.path) },
      ];

  contextMenu.open({ x: event.clientX, y: event.clientY }, items);
});

async function newFileIn(parentPath) {
  const name = await promptDialog('New file', 'File name:', '', { placeholder: 'app.js' });
  if (!name) return;
  const created = await explorer.createFile(parentPath, name);
  if (created) {
    setStatus(`Created ${name}`);
    openFile(created);
  }
}

async function newFolderIn(parentPath) {
  const name = await promptDialog('New folder', 'Folder name:', '', { placeholder: 'utils' });
  if (!name) return;
  const created = await explorer.createFolder(parentPath, name);
  if (created) setStatus(`Created ${name}`);
}

async function renameNode(node) {
  const name = await promptDialog('Rename', `Rename "${node.name}" to:`, node.name);
  if (!name || name === node.name) return;
  const renamed = await explorer.rename(node, name);
  if (renamed) {
    setStatus(`Renamed to ${name}`);
    if (state.files.has(node.path)) {
      const file = state.files.get(node.path);
      file.path = renamed;
      file.name = name;
      state.files.delete(node.path);
      state.files.set(renamed, file);
      state.order = state.order.map((entry) => (entry === node.path ? renamed : entry));
      if (state.activePath === node.path) state.activePath = renamed;
      renderTabs();
    }
  }
}

async function deleteNode(node) {
  const confirmed = await confirmDialog(
    'Delete',
    `"${node.name}" will be permanently deleted. This cannot be undone.`,
    { confirmLabel: 'Delete', danger: true },
  );
  if (!confirmed) return;

  const removed = await explorer.remove(node);
  if (removed) {
    setStatus(`Deleted ${node.name}`);
    if (state.files.has(node.path)) {
      closeFile(node.path);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Toolbar buttons
 * ------------------------------------------------------------------ */

document.getElementById('btn-open-project').addEventListener('click', openProject);
document.getElementById('btn-new-file').addEventListener('click', newFile);
document.getElementById('btn-new-folder').addEventListener('click', newFolder);
document.getElementById('btn-refresh').addEventListener('click', () => {
  explorer.refresh();
  setStatus('Explorer refreshed');
});
document.getElementById('btn-collapse').addEventListener('click', () => explorer.collapseAll());
document.getElementById('btn-save').addEventListener('click', () => saveActiveFile());
document.getElementById('btn-run').addEventListener('click', runActiveFile);
document.getElementById('btn-preview').addEventListener('click', openPreview);
document.getElementById('btn-terminal-clear').addEventListener('click', () => terminals.clear());
document.getElementById('btn-terminal-stop').addEventListener('click', stopProcess);
document.getElementById('btn-terminal-close').addEventListener('click', toggleTerminal);

/* ------------------------------------------------------------------ *
 * Window controls
 * ------------------------------------------------------------------ */

for (const button of document.querySelectorAll('[data-window]')) {
  button.addEventListener('click', async () => {
    const action = button.dataset.window;
    if (action === 'minimize') await api.window.minimize();
    if (action === 'maximize') {
      const maximized = await api.window.toggleMaximize();
      if (maxized.ok && maximized.data) {
        button.querySelector('use')?.setAttribute('href', '#i-restore');
        button.title = 'Restore';
      } else {
        button.querySelector('use')?.setAttribute('href', '#i-maximize');
        button.title = 'Maximize';
      }
    }
    if (action === 'close') await api.window.close();
  });
}

/* ------------------------------------------------------------------ *
 * Global keyboard shortcuts
 * ------------------------------------------------------------------ */

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;

  const ctrl = event.ctrlKey || event.metaKey;
  if (!ctrl) return;

  const key = event.key.toLowerCase();

  if (key === 's' && !event.shiftKey) {
    event.preventDefault();
    commands.execute('file.save');
  } else if (key === 'o' && !event.shiftKey) {
    event.preventDefault();
    commands.execute('project.open');
  } else if (key === 'n' && !event.shiftKey) {
    event.preventDefault();
    commands.execute('file.newFile');
  } else if (key === 'w' && !event.shiftKey) {
    event.preventDefault();
    commands.execute('file.closeTab');
  } else if (key === 'p' && event.shiftKey) {
    event.preventDefault();
    commands.execute('view.palette');
  } else if (key === 'p' && !event.shiftKey) {
    event.preventDefault();
    commands.execute('view.quickOpen');
  } else if (event.key === '`') {
    event.preventDefault();
    commands.execute('terminal.toggle');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'F5') {
    event.preventDefault();
    commands.execute('run.runJs');
  }
});

/* ------------------------------------------------------------------ *
 * Splitters
 * ------------------------------------------------------------------ */

function setupSplitter(element, { axis, min, max, apply, invert = false }) {
  let dragging = false;

  element.addEventListener('mousedown', (event) => {
    dragging = true;
    element.classList.add('splitter--active');
    document.body.style.cursor = axis === 'vertical' ? 'col-resize' : 'row-resize';
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    if (axis === 'vertical') {
      const value = invert ? window.innerWidth - event.clientX : event.clientX;
      apply(Math.max(min, Math.min(max, value)));
    } else {
      const value = invert ? window.innerHeight - event.clientY : event.clientY;
      apply(Math.max(min, Math.min(max, value)));
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('splitter--active');
    document.body.style.cursor = '';
  });
}

setupSplitter(document.getElementById('split-sidebar'), {
  axis: 'vertical',
  min: 170,
  max: 520,
  apply: (value) => dom.app.style.setProperty('--sidebar-w', `${value}px`),
});

setupSplitter(document.getElementById('split-terminal'), {
  axis: 'horizontal',
  min: 120,
  max: 720,
  invert: true,
  apply: (value) => dom.main.style.setProperty('--terminal-h', `${value}px`),
});

/* ------------------------------------------------------------------ *
 * IPC subscriptions
 * ------------------------------------------------------------------ */

api.terminal.onOutput((payload) => terminals.onOutput(payload));
api.terminal.onExit((payload) => terminals.onExit(payload));
api.app.onMenuCommand((commandId) => commands.execute(commandId));

/* ------------------------------------------------------------------ *
 * Test hooks
 *
 * Exposed so the automated self test (scripts/selftest.js) can drive the
 * application exactly like a user would, without reaching into internals.
 * ------------------------------------------------------------------ */

window.__codes = {
  openFile,
  openProject: applyProject,
  commands,
  state,
  terminals,
  editor,
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  const info = await api.app.info();
  if (info.ok) {
    dom.osBadge.textContent = info.data.osName;
    document.title = `Codes${state.projectName ? ` - ${state.projectName}` : ''}`;
  }

  const node = await api.process.nodeInfo();
  if (node.ok && node.data.available) {
    dom.statusShell.title = `Node.js ${node.data.version}`;
  }

  updateWelcomeVisibility();
  renderTabs();
  renderStatus();
  renderTerminalTabs();
  await renderRecentProjects();

  // Restore the last project first so the terminal starts in its folder.
  const root = await api.project.getRoot();
  if (root.ok && root.data.path) {
    await applyProject(root.data.path, root.data.path.split(/[\\/]/).filter(Boolean).pop());
  }

  // Start the default shell so the terminal is alive right away.
  await terminals.activate('cmd');
  renderTerminalTabs();
}

boot();
