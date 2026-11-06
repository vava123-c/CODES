/**
 * Codes 0.2 - Terminal.
 *
 * Real Windows processes (cmd.exe / powershell.exe) are driven over stdin and
 * stdout. Because the child has no console of its own, the shell prints its
 * prompt on stdout instead of drawing it, so Codes re-renders that prompt and
 * draws the typed line itself.
 *
 * A small line-buffer emulator is implemented here:
 *   - `\r` moves the cursor, `\b` moves it back, text overwrites in place
 *     (this is what progress bars such as `npm install` rely on),
 *   - ANSI SGR sequences are translated into CSS classes,
 *   - the echo of the command that was just sent is dropped so the typed line
 *     is never displayed twice.
 */

const MAX_LINES = 4000;

/** Matches "C:\path>" and "PS C:\path> " style prompts. */
const PROMPT_PATTERN = /^(?:PS\s+)?(?:[A-Za-z]:[^\r\n>]*|~\/[^\r\n>]*|\/[^\r\n>]*)>\s?/;

const ANSI_CLASSES = [
  'ansi-black',
  'ansi-red',
  'ansi-green',
  'ansi-yellow',
  'ansi-blue',
  'ansi-magenta',
  'ansi-cyan',
  'ansi-white',
];

const ANSI_BRIGHT = [
  'ansi-bright-black',
  'ansi-bright-red',
  'ansi-bright-green',
  'ansi-bright-yellow',
  'ansi-bright-blue',
  'ansi-bright-magenta',
  'ansi-bright-cyan',
  'ansi-bright-white',
];

/** Default style object shared by every cell that has no explicit colour. */
function defaultStyle() {
  return { cls: '', color: '', bg: '', bold: false, dim: false, italic: false, underline: false };
}

export function createTerminals({ host, api, onStatus, onError }) {
  /** @type {Map<string, object>} kind -> session */
  const sessions = new Map();
  /** @type {Map<string, string>} run id -> shell kind */
  const runTargets = new Map();
  let activeKind = 'cmd';
  let visible = true;

  /* ---------------------------------------------------------------- *
   * Session model
   * ---------------------------------------------------------------- */

  function createSession(kind, label) {
    const element = document.createElement('div');
    element.className = 'terminal';
    element.dataset.kind = kind;
    element.tabIndex = 0;
    element.setAttribute('role', 'log');
    element.setAttribute('aria-label', `${label} terminal`);

    const session = {
      kind,
      label,
      id: null,
      element,
      lines: [],
      cells: [],
      col: 0,
      style: defaultStyle(),
      input: '',
      inputCursor: 0,
      awaitingEcho: null,
      history: [],
      historyIndex: -1,
      busy: false,
      alive: false,
      started: false,
      activeLine: null,
    };

    element.addEventListener('keydown', (event) => handleKeyDown(session, event));
    element.addEventListener('mousedown', () => {
      element.focus();
    });

    return session;
  }

  async function ensureSession(kind) {
    let session = sessions.get(kind);
    if (session) {
      if (!session.started) await startSession(session);
      return session;
    }

    const label = kind === 'powershell' ? 'PowerShell' : 'CMD';
    session = createSession(kind, label);
    sessions.set(kind, session);
    await startSession(session);
    return session;
  }

  async function startSession(session) {
    session.started = true;
    const cwd = currentCwd();
    const response = await api.terminal.start(session.kind, cwd);
    if (!response.ok) {
      onError?.(response.error);
      session.started = false;
      return;
    }
    session.id = response.data.id;
    session.alive = true;
    session.busy = true;
    mountSession(session);
    onStatus?.();
  }

  /** Stop a shell and start it again in the current project directory. */
  async function restartSession(session) {
    if (session.id) await api.terminal.kill(session.id);
    session.id = null;
    session.alive = false;
    session.busy = false;
    session.input = '';
    session.inputCursor = 0;
    session.cells = [];
    session.col = 0;
    session.awaitingEcho = null;
    for (const line of session.lines) line.remove();
    session.lines = [];
    session.started = false;
    await startSession(session);
    renderActiveLine(session);
  }

  function currentCwd() {
    return projectRoot ?? undefined;
  }

  let projectRoot = null;

  function mountSession(session) {
    host.textContent = '';
    for (const other of sessions.values()) {
      other.element.classList.add('terminal--hidden');
    }
    session.element.classList.remove('terminal--hidden');
    host.appendChild(session.element);
    renderActiveLine(session);
    scrollToBottom(session);
  }

  function setActive(kind) {
    activeKind = kind;
    const session = sessions.get(kind);
    if (session) {
      mountSession(session);
      session.element.focus();
    }
    onStatus?.();
  }

  /* ---------------------------------------------------------------- *
   * Output handling
   * ---------------------------------------------------------------- */

  function cellsText(session) {
    let out = '';
    for (const cell of session.cells) out += cell.ch;
    return out;
  }

  function writeCell(session, ch) {
    const cell = { ch, style: session.style };
    if (session.col < session.cells.length) {
      session.cells[session.col] = cell;
    } else {
      session.cells.push(cell);
    }
    session.col += 1;
  }

  function commitLine(session) {
    const text = cellsText(session);

    if (session.awaitingEcho !== null) {
      const stripped = text.replace(PROMPT_PATTERN, '').trim();
      if (stripped === session.awaitingEcho.trim()) {
        // The shell echoed our command back - we already display it.
        session.awaitingEcho = null;
        session.cells = [];
        session.col = 0;
        return;
      }
      session.awaitingEcho = null;
    }

    if (text === '' && session.lines.length === 0 && session.cells.length === 0) {
      // Skip the empty line the shell prints before its first prompt.
      session.cells = [];
      session.col = 0;
      return;
    }

    const line = document.createElement('div');
    line.className = 'terminal__line';
    renderCells(line, session.cells);
    session.element.insertBefore(line, session.activeLine);
    session.lines.push(line);

    while (session.lines.length > MAX_LINES) {
      const removed = session.lines.shift();
      removed?.remove();
    }

    session.cells = [];
    session.col = 0;
    scrollToBottom(session);
  }

  function renderCells(line, cells) {
    if (cells.length === 0) {
      line.textContent = '';
      return;
    }
    let index = 0;
    while (index < cells.length) {
      const style = cells[index].style;
      let end = index;
      while (end < cells.length && cells[end].style === style) end += 1;

      const span = document.createElement('span');
      let text = '';
      for (let i = index; i < end; i += 1) text += cells[i].ch;
      span.textContent = text;
      applyStyle(span, style);
      line.appendChild(span);
      index = end;
    }
  }

  function applyStyle(element, style) {
    if (style.cls) element.className = style.cls;
    if (style.color) element.style.color = style.color;
    if (style.bg) element.style.backgroundColor = style.bg;
    if (style.bold) element.style.fontWeight = '700';
    if (style.dim) element.style.opacity = '0.68';
    if (style.italic) element.style.fontStyle = 'italic';
    if (style.underline) element.style.textDecoration = 'underline';
  }

  /** Feed raw process output into the emulator. */
  function feed(session, text, stream) {
    let index = 0;

    while (index < text.length) {
      const ch = text[index];

      if (ch === '\x1b') {
        const next = text[index + 1];
        if (next === '[') {
          let cursor = index + 2;
          while (cursor < text.length && !/[@-~]/.test(text[cursor])) cursor += 1;
          const params = text.slice(index + 2, cursor);
          const final = text[cursor] || '';
          if (final === 'm') applySgr(session, params);
          index = cursor + 1;
          continue;
        }
        if (next === ']') {
          // OSC: skip until BEL or ST
          let cursor = index + 2;
          while (cursor < text.length && text[cursor] !== '\x07' && text[cursor] !== '\x1b') cursor += 1;
          index = cursor + 1;
          continue;
        }
        index += 2;
        continue;
      }

      if (ch === '\n') {
        commitLine(session);
        index += 1;
        continue;
      }
      if (ch === '\r') {
        session.col = 0;
        index += 1;
        continue;
      }
      if (ch === '\b') {
        session.col = Math.max(0, session.col - 1);
        index += 1;
        continue;
      }
      if (ch === '\t') {
        const width = 4;
        const nextStop = (Math.floor(session.col / width) + 1) * width;
        while (session.col < nextStop) writeCell(session, ' ');
        index += 1;
        continue;
      }
      if (ch < ' ') {
        index += 1;
        continue;
      }

      writeCell(session, ch);
      index += 1;
    }

    if (stream === 'stderr' && session.cells.length) {
      session.style = { ...session.style, cls: 'ansi-red' };
    }

    renderActiveLine(session);
  }

  function applySgr(session, params) {
    const codes = params
      .split(';')
      .map((value) => (value === '' ? 0 : parseInt(value, 10)))
      .filter((value) => !Number.isNaN(value));

    if (codes.length === 0) codes.push(0);

    let style = { ...session.style };

    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) {
        style = defaultStyle();
      } else if (code === 1) {
        style.bold = true;
      } else if (code === 2) {
        style.dim = true;
      } else if (code === 3) {
        style.italic = true;
      } else if (code === 4) {
        style.underline = true;
      } else if (code === 22) {
        style.bold = false;
        style.dim = false;
      } else if (code === 23) {
        style.italic = false;
      } else if (code === 24) {
        style.underline = false;
      } else if (code >= 30 && code <= 37) {
        style.cls = ANSI_CLASSES[code - 30];
        style.color = '';
      } else if (code >= 90 && code <= 97) {
        style.cls = ANSI_BRIGHT[code - 90];
        style.color = '';
      } else if (code === 39) {
        style.cls = '';
        style.color = '';
      } else if (code >= 40 && code <= 47) {
        style.bg = backgroundFor(code - 40);
      } else if (code >= 100 && code <= 107) {
        style.bg = backgroundFor(code - 100);
      } else if (code === 49) {
        style.bg = '';
      } else if (code === 38 || code === 48) {
        const target = code === 38 ? 'color' : 'bg';
        if (codes[i + 1] === 5) {
          const value = codes[i + 2] ?? 0;
          style[target] = xterm256(value);
          i += 2;
        } else if (codes[i + 1] === 2) {
          const r = codes[i + 2] ?? 0;
          const g = codes[i + 3] ?? 0;
          const b = codes[i + 4] ?? 0;
          style[target] = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        }
      }
    }

    session.style = style;
  }

  const BG_COLORS = ['#0d121b', '#f2564d', '#56d364', '#e3b341', '#4c8dff', '#bc8cff', '#39c5cf', '#d6dceb'];
  function backgroundFor(index) {
    return BG_COLORS[index] || '';
  }

  function xterm256(value) {
    if (value < 16) {
      const palette = [
        '#1b2433', '#f2564d', '#56d364', '#e3b341',
        '#4c8dff', '#bc8cff', '#39c5cf', '#d6dceb',
        '#4d5768', '#ff7b72', '#7ee787', '#ffd479',
        '#79b8ff', '#d2a8ff', '#56d4dd', '#ffffff',
      ];
      return palette[value] || '#d6dceb';
    }
    if (value < 232) {
      const index = value - 16;
      const r = Math.floor(index / 36);
      const g = Math.floor((index % 36) / 6);
      const b = index % 6;
      const level = (v) => (v === 0 ? 0 : 55 + v * 40);
      return `rgb(${level(r)}, ${level(g)}, ${level(b)})`;
    }
    const grey = 8 + (value - 232) * 10;
    return `rgb(${grey}, ${grey}, ${grey})`;
  }

  /* ---------------------------------------------------------------- *
   * Active (typed) line
   * ---------------------------------------------------------------- */

  function ensureActiveLine(session) {
    if (!session.activeLine) {
      const line = document.createElement('div');
      line.className = 'terminal__line terminal__line--active';
      session.element.appendChild(line);
      session.activeLine = line;
    }
    return session.activeLine;
  }

  function renderActiveLine(session) {
    const line = ensureActiveLine(session);
    const prompt = cellsText(session);
    line.textContent = '';

    if (prompt) {
      const promptSpan = document.createElement('span');
      promptSpan.textContent = prompt;
      line.appendChild(promptSpan);
    }

    const before = session.input.slice(0, session.inputCursor);
    const after = session.input.slice(session.inputCursor);

    const beforeSpan = document.createElement('span');
    beforeSpan.textContent = before;
    line.appendChild(beforeSpan);

    const cursor = document.createElement('span');
    cursor.className = 'terminal__cursor';
    line.appendChild(cursor);

    if (after) {
      const afterSpan = document.createElement('span');
      afterSpan.textContent = after;
      line.appendChild(afterSpan);
    }

    scrollToBottom(session);
  }

  function scrollToBottom(session) {
    const element = session.element;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  async function handleKeyDown(session, event) {
    const { key, ctrlKey, altKey, metaKey } = event;

    if (metaKey) return;

    if (ctrlKey && key.toLowerCase() === 'c') {
      event.preventDefault();
      const runId = findRunFor(session.kind);
      if (runId) {
        await api.process.kill(runId);
        appendSystem(session, '^C');
        return;
      }
      session.input = '';
      session.inputCursor = 0;
      renderActiveLine(session);
      api.terminal.write(session.id, '\x03');
      return;
    }

    if (ctrlKey && key.toLowerCase() === 'l') {
      event.preventDefault();
      clearSession(session);
      return;
    }

    if (ctrlKey && key.toLowerCase() === 'a') {
      event.preventDefault();
      session.inputCursor = 0;
      renderActiveLine(session);
      return;
    }

    if (ctrlKey && key.toLowerCase() === 'e') {
      event.preventDefault();
      session.inputCursor = session.input.length;
      renderActiveLine(session);
      return;
    }

    if (ctrlKey && key.toLowerCase() === 'u') {
      event.preventDefault();
      session.input = '';
      session.inputCursor = 0;
      renderActiveLine(session);
      return;
    }

    if (ctrlKey || altKey) return;

    switch (key) {
      case 'Enter': {
        event.preventDefault();
        submit(session);
        return;
      }
      case 'Backspace': {
        event.preventDefault();
        if (session.inputCursor > 0) {
          session.input =
            session.input.slice(0, session.inputCursor - 1) + session.input.slice(session.inputCursor);
          session.inputCursor -= 1;
          renderActiveLine(session);
        }
        return;
      }
      case 'Delete': {
        event.preventDefault();
        session.input =
          session.input.slice(0, session.inputCursor) + session.input.slice(session.inputCursor + 1);
        renderActiveLine(session);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        session.inputCursor = Math.max(0, session.inputCursor - 1);
        renderActiveLine(session);
        return;
      }
      case 'ArrowRight': {
        event.preventDefault();
        session.inputCursor = Math.min(session.input.length, session.inputCursor + 1);
        renderActiveLine(session);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        navigateHistory(session, -1);
        return;
      }
      case 'ArrowDown': {
        event.preventDefault();
        navigateHistory(session, 1);
        return;
      }
      case 'Home': {
        event.preventDefault();
        session.inputCursor = 0;
        renderActiveLine(session);
        return;
      }
      case 'End': {
        event.preventDefault();
        session.inputCursor = session.input.length;
        renderActiveLine(session);
        return;
      }
      case 'Tab': {
        event.preventDefault();
        await completeInput(session);
        return;
      }
      default:
        break;
    }

    if (key.length === 1) {
      event.preventDefault();
      session.input =
        session.input.slice(0, session.inputCursor) + key + session.input.slice(session.inputCursor);
      session.inputCursor += 1;
      renderActiveLine(session);
    }
  }

  function submit(session) {
    const command = session.input;

    // Render the command exactly as typed, then hand it to the real process.
    const line = document.createElement('div');
    line.className = 'terminal__line';
    const promptSpan = document.createElement('span');
    promptSpan.textContent = cellsText(session);
    line.appendChild(promptSpan);
    const commandSpan = document.createElement('span');
    commandSpan.textContent = command;
    line.appendChild(commandSpan);
    session.element.insertBefore(line, session.activeLine);
    session.lines.push(line);

    session.input = '';
    session.inputCursor = 0;
    session.cells = [];
    session.col = 0;
    session.awaitingEcho = command;

    if (command.trim()) {
      session.history.push(command);
      session.historyIndex = session.history.length;
    }

    renderActiveLine(session);
    api.terminal.write(session.id, `${command}\r\n`);
  }

  function navigateHistory(session, direction) {
    if (session.history.length === 0) return;
    let index = session.historyIndex + direction;
    if (index < 0) index = 0;
    if (index > session.history.length) index = session.history.length;
    session.historyIndex = index;
    session.input = index === session.history.length ? '' : session.history[index];
    session.inputCursor = session.input.length;
    renderActiveLine(session);
  }

  /** Local path completion against the real file system. */
  async function completeInput(session) {
    const text = session.input;
    const match = /([^\s"']*)$/.exec(text);
    if (!match) return;
    const token = match[1];

    const slash = Math.max(token.lastIndexOf('\\'), token.lastIndexOf('/'));
    const dirPart = slash === -1 ? '' : token.slice(0, slash + 1);
    const namePart = token.slice(slash + 1);
    const cwd = promptDirectory(session);
    const targetDir = dirPart ? joinPath(cwd, dirPart) : cwd;

    const response = await api.fs.list(targetDir);
    if (!response.ok) return;

    const candidates = response.data
      .filter((entry) => entry.name.toLowerCase().startsWith(namePart.toLowerCase()))
      .map((entry) => entry.name);

    if (candidates.length === 0) return;

    let common = candidates[0];
    for (const candidate of candidates) {
      while (!candidate.toLowerCase().startsWith(common.toLowerCase())) {
        common = common.slice(0, -1);
      }
    }

    const completion = common.length > namePart.length ? common : candidates[0];
    const addition = dirPart + completion + (candidates.length === 1 ? ' ' : '');
    session.input = text.slice(0, text.length - token.length) + addition;
    session.inputCursor = session.input.length;
    renderActiveLine(session);
  }

  function promptDirectory(session) {
    const prompt = cellsText(session);
    const match = PROMPT_PATTERN.exec(prompt);
    if (match) {
      const raw = prompt.slice(0, match[0].length).replace(/^PS\s+/, '').replace(/>\s?$/, '').trim();
      if (raw) return raw;
    }
    return projectRoot || '';
  }

  function joinPath(base, relative) {
    const separator = base.includes('\\') ? '\\' : '/';
    return base.replace(/[\\/]+$/, '') + separator + relative.replace(/^[\\/]+/, '');
  }

  function appendSystem(session, text) {
    const line = document.createElement('div');
    line.className = 'terminal__line terminal__line--system';
    line.textContent = text;
    session.element.insertBefore(line, session.activeLine);
    session.lines.push(line);
    scrollToBottom(session);
  }

  function clearSession(session) {
    for (const line of session.lines) line.remove();
    session.lines = [];
    session.cells = [];
    session.col = 0;
    renderActiveLine(session);
  }

  function findRunFor(kind) {
    for (const [runId, target] of runTargets.entries()) {
      if (target === kind) return runId;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  return {
    /** Create the session for a shell kind and show it. */
    async activate(kind) {
      await ensureSession(kind);
      setActive(kind);
    },

    async ensure(kind) {
      return ensureSession(kind);
    },

    setProjectRoot(root) {
      const previous = projectRoot;
      projectRoot = root;
      if (previous === root) return;
      // A shell that was started in a different directory is restarted so the
      // prompt always shows the project folder.
      for (const session of sessions.values()) {
        if (session.started && session.alive && session.cwd !== root) {
          restartSession(session);
        }
      }
    },

    /** Route process output to the right session. */
    onOutput(payload) {
      const session = sessions.get(activeKind);
      const target = runTargets.get(payload.id);
      const destination = target ? sessions.get(target) : sessions.get(kindOf(payload.id));

      if (!destination) return;
      destination.busy = true;
      feed(destination, payload.text, payload.stream);
      onStatus?.();
    },

    onExit(payload) {
      const target = runTargets.get(payload.id);
      const destination = target ? sessions.get(target) : sessions.get(kindOf(payload.id));

      if (target) {
        runTargets.delete(payload.id);
        if (destination) {
          appendResult(destination, payload.code);
          destination.busy = false;
        }
      } else if (destination) {
        appendResult(destination, payload.code);
        destination.busy = false;
        destination.alive = false;
      }
      onStatus?.();
    },

    /** Remember which terminal a "Run" process belongs to. */
    attachRun(runId) {
      runTargets.set(runId, activeKind);
    },

    detachRun(runId) {
      runTargets.delete(runId);
    },

    hasRun(kind) {
      return Boolean(findRunFor(kind));
    },

    clear() {
      const session = sessions.get(activeKind);
      if (session) clearSession(session);
    },

    async stop() {
      const runId = findRunFor(activeKind);
      if (runId) {
        await api.process.kill(runId);
        runTargets.delete(runId);
        const session = sessions.get(activeKind);
        if (session) {
          appendResult(session, 1, true);
          session.busy = false;
        }
        return true;
      }
      return false;
    },

    get activeKind() {
      return activeKind;
    },

    get activeSession() {
      return sessions.get(activeKind);
    },

    setVisible(value) {
      visible = value;
      if (value) {
        const session = sessions.get(activeKind);
        if (session) session.element.focus();
      }
    },

    get visible() {
      return visible;
    },
  };

  function kindOf(id) {
    for (const session of sessions.values()) {
      if (session.id === id) return session.kind;
    }
    return null;
  }

  function appendResult(session, code, stopped = false) {
    const line = document.createElement('div');
    line.className = 'terminal__line terminal__line--success';
    line.textContent = stopped
      ? 'Process stopped'
      : `Process exited with code ${code}`;
    session.element.insertBefore(line, session.activeLine);
    session.lines.push(line);
    scrollToBottom(session);
  }
}
