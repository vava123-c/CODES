# Codes 0.2

**Lightweight Development Environment** for Windows 10 / 11 — JavaScript, HTML and CSS.

Codes is a small, fast desktop IDE built with Electron and CodeMirror 6. It is designed
for 8 GB Windows 10 machines: no framework, no heavy UI library, no background polling and
no continuous filesystem watching. The only runtime dependency is Electron itself; the
editor is CodeMirror 6, loaded module by module.

---

## Quick start

1. Install **Node.js LTS** from <https://nodejs.org> (required to run the editor).
2. Extract `Codes_0.2.zip` to any folder.
3. Double click **`START_CODES.bat`**.

On the first run the script installs the dependencies (`npm install`, downloads Electron
once) and then starts the editor. Every later run starts immediately.

You can also start it from a terminal:

```bat
npm install
npm start
```

---

## Features

### Editor

* CodeMirror 6 with syntax highlighting, line numbers, indentation, bracket matching
  and auto-closing brackets.
* Languages: **JavaScript** (`.js`, `.mjs`, `.cjs`, `.jsx`), **HTML** (`.html`, `.htm`),
  **CSS** (`.css`) and **JSON** (`.json`).
* Search & replace panel, auto-complete, folding, multiple selections.
* Every open file keeps its own cursor position, selection and undo history when you
  switch tabs.
* A Codes-specific colour theme — deliberately not a VS Code look-alike.

### Explorer

* Reads the **real** file system, folders are loaded on demand.
* Open, create file, create folder, rename, delete, refresh, collapse all.
* `node_modules`, `.git` and similar folders are hidden by default.
* The file that is open in the editor is highlighted in the tree.
* Right click for a context menu (Open / New File / New Folder / Rename / Delete / Refresh).

### Tabs

* Active tab, close button, `*` marker for unsaved changes, file type icon.
* Middle click closes a tab, `Ctrl+W` closes the active one.

### Terminal — real Windows processes

* Runs a **real** `cmd.exe` or `powershell.exe`, not a simulated prompt.
* stdin, stdout, stderr, exit codes and process termination are all wired up.
* The shell starts in the project folder, so `dir`, `cd src`, `node app.js`,
  `npm install`, `npm run dev`, `git status` and `python test.py` all work.
* UTF-8 is handled end to end — Turkish and Azerbaijani characters survive the round trip.
* ANSI colours are translated, and progress bars (`npm install`) redraw in place.
* Command history (`↑` / `↓`), line editing, `Ctrl+C`, `Ctrl+L`, `Ctrl+A/E/U` and
  path completion with `Tab`.

### Run

* `F5` or the ▶ button runs the active JavaScript file with Node.js and streams the
  output into the terminal, followed by `Process exited with code 0`.
* The stop button terminates a running process.

### HTML preview

* HTML files can be opened in a live preview window that loads the project over a
  dedicated `preview://` origin, so relative `style.css` / `app.js` and ES modules work
  exactly like in a browser.
* Saving the file reloads the preview.

### Command palette & quick open

* `Ctrl+Shift+P` opens the command palette, `Ctrl+P` searches for files by name.
* Fuzzy matching, arrow key navigation, `Enter` to run.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + S` | Save the active file |
| `Ctrl + O` | Open project |
| `Ctrl + N` | New file |
| `Ctrl + W` | Close tab |
| `Ctrl + P` | Quick open (search files) |
| `Ctrl + Shift + P` | Command palette |
| `Ctrl + \`` | Show / hide the terminal |
| `Ctrl + Shift + F` | Find in file |
| `F5` | Run the active JavaScript file |
| `Ctrl + Z` / `Ctrl + Y` | Undo / redo |

---

## Project layout

```text
Codes/
├── package.json
├── README.md
├── START_CODES.bat
├── src/
│   ├── main.js          Electron main process: protocols, windows, IPC
│   ├── preload.js       the only bridge to the OS (window.codesAPI)
│   ├── renderer.js      application shell: state, commands, wiring
│   ├── editor.js        CodeMirror 6 setup, theme, languages, key bindings
│   ├── terminal.js      terminal emulator, CMD / PowerShell sessions
│   ├── explorer.js      file tree over the real file system
│   ├── tabs.js          tab bar
│   ├── preview.js       HTML preview window
│   ├── commands.js      command registry, command palette, context menus
│   ├── styles.css       design tokens and all component styles
│   └── index.html       application shell markup + import map
└── scripts/             build and verification helpers
```

---

## Security model

* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
* The renderer never touches Node.js. `src/preload.js` exposes exactly one object,
  `window.codesAPI`, with whitelisted IPC channels for the file system, the project, the
  terminal, processes, the preview window and the window controls.
* The UI is served over the custom `app://` scheme; the file system handler rejects any
  path that escapes the application folder.
* A Content Security Policy restricts scripts to the application itself. The inline
  import map is allowed through a SHA-256 hash that `scripts/sync-csp.mjs` keeps in sync.

---

## Notes and limitations

* The terminal drives the shell over a pipe, not through a Windows pseudo console.
  Interactive programs that need a real console (full screen `vim`, `less`) are limited,
  and `Ctrl+C` cannot interrupt a program running *inside* the shell — it does terminate
  a script that Codes started itself with **Run**.
* Running JavaScript needs Node.js on the machine. Codes reports a clear message when
  it cannot find it.

---

## Development helpers

```bat
npm run selftest     :: boots the app and verifies 16 behaviours end to end
npm run check        :: parses every source module and reports syntax errors
npm run setup        :: regenerates the import map and the CSP hash
npm run zip          :: creates Codes_0.2.zip without node_modules
```

`npm run selftest` starts the real application, exercises the file system bridge, both
shells, running a script, the preview window, the editor and the command palette, and
writes screenshots to the temp folder.
