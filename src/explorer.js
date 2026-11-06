/**
 * Codes 0.2 - Explorer.
 *
 * A lazy tree over the real file system. Folders are loaded on demand, the
 * active file is highlighted and every mutation (new file / new folder /
 * rename / delete) is executed through the preload bridge.
 */

const HIDDEN_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg', '.cache']);
const HIDDEN_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export function createExplorer({ container, api, onOpenFile, onActiveChange, onError, onRefresh }) {
  /** @type {{name: string, path: string, isDirectory: boolean, expanded: boolean, loaded: boolean, children: any[]}|null} */
  let root = null;
  let activePath = null;
  let renaming = null;

  /* ---------------------------------------------------------------- *
   * Data
   * ---------------------------------------------------------------- */

  async function setRoot(rootPath, name) {
    if (!rootPath) {
      root = null;
      render();
      return;
    }
    root = {
      name: name || rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath,
      path: rootPath,
      isDirectory: true,
      expanded: true,
      loaded: false,
      children: [],
    };
    await loadChildren(root);
    render();
  }

  async function loadChildren(node) {
    const response = await api.fs.list(node.path);
    if (!response.ok) {
      onError?.(response.error);
      node.children = [];
      node.loaded = true;
      return;
    }
    node.children = response.data
      .filter((entry) => !isHidden(entry))
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
        expanded: false,
        loaded: false,
        children: [],
      }));
    node.loaded = true;
  }

  function isHidden(entry) {
    if (entry.isDirectory) return HIDDEN_DIRECTORIES.has(entry.name);
    return HIDDEN_FILES.has(entry.name);
  }

  function refresh() {
    if (!root) return;
    (async () => {
      const expandedPaths = new Set();
      collectExpanded(root, expandedPaths);
      await loadChildren(root);
      restoreExpanded(root, expandedPaths);
      render();
      onRefresh?.();
    })();
  }

  function collectExpanded(node, acc) {
    if (node.expanded) acc.add(node.path);
    for (const child of node.children || []) collectExpanded(child, acc);
  }

  function restoreExpanded(node, expandedPaths) {
    if (!node.children) return;
    for (const child of node.children) {
      if (expandedPaths.has(child.path)) {
        child.expanded = true;
        if (!child.loaded) {
          loadChildren(child).then(() => render());
          continue;
        }
      }
      restoreExpanded(child, expandedPaths);
    }
  }

  function collapseAll() {
    if (!root) return;
    const walk = (node) => {
      node.expanded = node === root;
      for (const child of node.children || []) walk(child);
    };
    walk(root);
    render();
  }

  function findNode(node, targetPath) {
    if (!node) return null;
    if (node.path === targetPath) return node;
    for (const child of node.children || []) {
      const found = findNode(child, targetPath);
      if (found) return found;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function render() {
    container.textContent = '';
    if (!root) {
      const empty = document.createElement('div');
      empty.className = 'explorer__empty';
      empty.textContent = 'No project open';
      container.appendChild(empty);
      return;
    }
    container.appendChild(buildRow(root, 0));
    for (const child of root.children || []) {
      container.appendChild(buildSubtree(child, 0));
    }
  }

  function buildSubtree(node, depth) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(buildRow(node, depth));
    if (node.expanded && node.isDirectory) {
      for (const child of node.children || []) {
        fragment.appendChild(buildSubtree(child, depth + 1));
      }
    }
    return fragment;
  }

  function buildRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = node.path;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    if (node.path === activePath) row.classList.add('tree-row--active');

    const twisty = document.createElement('span');
    twisty.className = 'tree-row__twisty';
    if (node.isDirectory) {
      if (node.expanded) twisty.classList.add('tree-row__twisty--open');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-chevron');
      svg.appendChild(use);
      twisty.appendChild(svg);
    } else {
      twisty.classList.add('tree-row__twisty--leaf');
    }
    row.appendChild(twisty);

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tree-row__icon';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', node.isDirectory ? (node.expanded ? '#i-folder-open' : '#i-folder') : fileIcon(node.name));
    icon.appendChild(use);
    iconWrap.appendChild(icon);
    row.appendChild(iconWrap);

    if (renaming === node.path) {
      const input = document.createElement('input');
      input.className = 'tree-row__input';
      input.value = node.name;
      input.spellcheck = false;
      row.appendChild(input);

      const commit = async (save) => {
        const value = input.value.trim();
        renaming = null;
        if (!save || !value || value === node.name) {
          render();
          return;
        }
        const parentPath = node.path.slice(0, node.path.lastIndexOf('\\'));
        const target = `${parentPath}\\${value}`;
        const response = await api.fs.rename(node.path, target);
        if (!response.ok) {
          onError?.(response.error);
          render();
          return;
        }
        node.path = target;
        node.name = value;
        render();
      };

      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          commit(false);
        }
      });
      input.addEventListener('blur', () => commit(true));
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return row;
    }

    const label = document.createElement('span');
    label.className = 'tree-row__label';
    label.textContent = node.name;
    row.appendChild(label);

    row.addEventListener('click', () => onRowClick(node));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRowClick(node);
    });

    return row;
  }

  function fileIcon(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return '#i-file-js';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return '#i-file-html';
    if (lower.endsWith('.css')) return '#i-file-css';
    return '#i-file';
  }

  async function onRowClick(node) {
    if (node.isDirectory) {
      node.expanded = !node.expanded;
      if (node.expanded && !node.loaded) {
        await loadChildren(node);
      }
      render();
    } else {
      onOpenFile?.(node.path, node.name);
    }
  }

  /* ---------------------------------------------------------------- *
   * Mutations
   * ---------------------------------------------------------------- */

  async function createFile(parentPath, name) {
    const response = await api.fs.createFile(parentPath, name);
    if (!response.ok) {
      onError?.(response.error);
      return null;
    }
    await ensureLoaded(parentPath);
    render();
    return response.data.path;
  }

  async function createFolder(parentPath, name) {
    const response = await api.fs.createFolder(parentPath, name);
    if (!response.ok) {
      onError?.(response.error);
      return null;
    }
    await ensureLoaded(parentPath);
    render();
    return response.data.path;
  }

  async function rename(node, newName) {
    const parentPath = node.path.slice(0, node.path.lastIndexOf('\\'));
    const target = `${parentPath}\\${newName}`;
    const response = await api.fs.rename(node.path, target);
    if (!response.ok) {
      onError?.(response.error);
      return null;
    }
    node.path = target;
    node.name = newName;
    render();
    return target;
  }

  async function remove(node) {
    const response = await api.fs.remove(node.path);
    if (!response.ok) {
      onError?.(response.error);
      return false;
    }
    await ensureLoaded(node.path.slice(0, node.path.lastIndexOf('\\')));
    render();
    return true;
  }

  async function ensureLoaded(dirPath) {
    if (!root) return;
    const node = findNode(root, dirPath);
    if (!node) {
      await loadChildren(root);
      return;
    }
    if (!node.loaded) await loadChildren(node);
  }

  return {
    setRoot,
    refresh,
    collapseAll,
    render,
    createFile,
    createFolder,
    rename,
    remove,
    findNode,
    get root() {
      return root;
    },
    setActivePath(path) {
      activePath = path;
      render();
    },
    beginRename(node) {
      renaming = node.path;
      render();
    },
  };
}
