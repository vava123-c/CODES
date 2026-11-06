/**
 * Codes 0.2 - Command registry, command palette and quick open.
 *
 * Every user visible action is a command. The palette, the menu bar, the
 * keyboard shortcuts and the context menus all dispatch through the same
 * registry, so a command can never exist in one place only.
 */

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export function createCommandRegistry() {
  /** @type {Map<string, {id: string, title: string, category: string, shortcut?: string, run: Function, when?: Function}>} */
  const commands = new Map();

  return {
    register(command) {
      commands.set(command.id, command);
      return this;
    },

    get(id) {
      return commands.get(id);
    },

    /** All commands, optionally filtered by a predicate. */
    list(filter) {
      const all = [...commands.values()];
      return filter ? all.filter(filter) : all;
    },

    execute(id, ...args) {
      const command = commands.get(id);
      if (!command) return false;
      if (command.when && !command.when()) return false;
      command.run(...args);
      return true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fuzzy matching
 * ------------------------------------------------------------------ */

/**
 * Subsequence match with a score. Returns null when the needle does not match.
 * @param {string} needle
 * @param {string} haystack
 */
export function fuzzyMatch(needle, haystack) {
  if (!needle) return { score: 0, positions: [] };
  const lowerNeedle = needle.toLowerCase();
  const lowerHaystack = haystack.toLowerCase();

  let score = 0;
  let index = 0;
  let previous = -1;
  const positions = [];

  for (const char of lowerNeedle) {
    const found = lowerHaystack.indexOf(char, index);
    if (found === -1) return null;
    positions.push(found);
    score += 10;
    if (previous !== -1) {
      const gap = found - previous - 1;
      score -= Math.min(gap, 8);
    }
    if (found === 0 || /[\s/\-_.]/.test(lowerHaystack[found - 1] || '')) {
      score += 6; // word start bonus
    }
    previous = found;
    index = found + 1;
  }

  score -= Math.min(haystack.length - needle.length, 20);
  return { score, positions };
}

/** Wrap the matched characters of a label in <mark> elements. */
export function highlightMatch(label, positions) {
  if (!positions || positions.length === 0) return escapeHtml(label);
  const set = new Set(positions);
  let html = '';
  let open = false;
  for (let i = 0; i < label.length; i += 1) {
    const marked = set.has(i);
    if (marked && !open) {
      html += '<mark>';
      open = true;
    }
    if (!marked && open) {
      html += '</mark>';
      open = false;
    }
    html += escapeHtml(label[i]);
  }
  if (open) html += '</mark>';
  return html;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ *
 * Palette / quick open overlay
 * ------------------------------------------------------------------ */

/**
 * Create the palette overlay.
 *
 * @param {object} options
 * @param {HTMLElement} options.root      the overlay element
 * @param {HTMLElement} options.input     the text input
 * @param {HTMLElement} options.list      the result list
 * @param {() => Array<{id: string, label: string, detail?: string, icon?: string, shortcut?: string}>} options.getItems
 * @param {(id: string) => void} options.onSelect
 */
export function createPalette({ root, input, list, getItems, onSelect }) {
  let items = [];
  let selectedIndex = 0;
  let mode = 'command';
  let open = false;

  function setMode(nextMode, placeholder) {
    mode = nextMode;
    input.placeholder = placeholder;
    input.value = '';
    selectedIndex = 0;
  }

  function refresh() {
    const query = input.value.trim();
    const all = getItems(mode);
    items = all
      .map((item) => {
        const match = fuzzyMatch(query, `${item.label} ${item.detail || ''}`);
        return match ? { ...item, ...match } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    list.textContent = '';

    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'palette__empty';
      empty.textContent = 'No matching results';
      list.appendChild(empty);
      return;
    }

    items.forEach((item, index) => {
      const element = document.createElement('li');
      element.className = 'palette-item';
      element.setAttribute('role', 'option');
      if (index === selectedIndex) {
        element.classList.add('palette-item--selected');
        element.setAttribute('aria-selected', 'true');
      }

      if (item.icon) {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#${item.icon}`);
        icon.appendChild(use);
        icon.classList.add('palette-item__icon');
        element.appendChild(icon);
      }

      const label = document.createElement('span');
      label.className = 'palette-item__label';
      label.innerHTML = highlightMatch(item.label, item.positions);
      element.appendChild(label);

      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'palette-item__category';
        detail.textContent = item.detail;
        element.appendChild(detail);
      }

      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'palette-item__shortcut';
        shortcut.textContent = item.shortcut;
        element.appendChild(shortcut);
      }

      element.addEventListener('mouseenter', () => {
        selectedIndex = index;
        syncSelection();
      });
      element.addEventListener('click', () => {
        select(index);
      });

      list.appendChild(element);
    });

    scrollSelectedIntoView();
  }

  function syncSelection() {
    const children = [...list.children];
    children.forEach((child, index) => {
      const isSelected = index === selectedIndex;
      child.classList.toggle('palette-item--selected', isSelected);
      child.setAttribute('aria-selected', String(isSelected));
    });
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    const child = list.children[selectedIndex];
    if (child && child.scrollIntoView) {
      child.scrollIntoView({ block: 'nearest' });
    }
  }

  function select(index) {
    const item = items[index];
    if (!item) return;
    close();
    onSelect(item.id, item);
  }

  function show(nextMode = 'command') {
    open = true;
    root.hidden = false;
    setMode(nextMode, nextMode === 'file' ? 'Search files by name…' : 'Type a command…');
    refresh();
    input.focus();
    input.select();
  }

  function close() {
    open = false;
    root.hidden = true;
    input.value = '';
  }

  input.addEventListener('input', refresh);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      syncSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      syncSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(selectedIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });

  return {
    show,
    close,
    get isOpen() {
      return open;
    },
    get mode() {
      return mode;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

/**
 * Create a floating context menu.
 *
 * @param {HTMLElement} options.element
 */
export function createContextMenu({ element }) {
  function close() {
    element.hidden = true;
    element.textContent = '';
  }

  /**
   * @param {{x: number, y: number}} position
   * @param {Array<{label?: string, icon?: string, shortcut?: string, danger?: boolean, disabled?: boolean, separator?: boolean, onSelect?: Function}>} items
   */
  function open(position, items) {
    element.textContent = '';

    for (const item of items) {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'contextmenu__sep';
        element.appendChild(separator);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'contextmenu__item';
      if (item.danger) button.classList.add('contextmenu__item--danger');
      if (item.disabled) button.classList.add('contextmenu__item--disabled');

      if (item.icon) {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#${item.icon}`);
        icon.appendChild(use);
        button.appendChild(icon);
      }

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
        close();
        if (!item.disabled) item.onSelect?.();
      });

      element.appendChild(button);
    }

    element.hidden = false;

    // Keep the menu inside the viewport.
    const rect = element.getBoundingClientRect();
    const left = Math.min(position.x, window.innerWidth - rect.width - 8);
    const top = Math.min(position.y, window.innerHeight - rect.height - 8);
    element.style.left = `${Math.max(8, left)}px`;
    element.style.top = `${Math.max(8, top)}px`;
  }

  document.addEventListener('mousedown', (event) => {
    if (!element.hidden && !element.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('blur', close);

  return { open, close };
}
