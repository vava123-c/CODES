'use strict';

/**
 * Codes 0.2 - automated self test.
 *
 * Boots the real application inside Electron and verifies the parts that
 * matter: renderer start-up, the filesystem bridge, the real CMD and
 * PowerShell sessions, running a JavaScript file with Node.js, the HTML
 * preview and the import map that feeds CodeMirror.
 *
 * A screenshot of the running UI is written to the temp folder so the
 * interface can be inspected without a human in the loop.
 */

const { app, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} context
 * @param {object} context.state    the main process state object
 * @param {Function} context.sendToRenderer
 */
async function runSelfTest(context) {
  const { state, sendToRenderer, shutdownSessions } = context;
  const win = state.mainWindow;
  const results = [];
  let failures = 0;

  // A unique folder per run: a shell that is still shutting down can keep the
  // previous folder locked.
  const workspace = path.join(app.getPath('temp'), `codes-selftest-${Date.now()}`);
  await fsp.mkdir(path.join(workspace, 'src'), { recursive: true });

  async function test(name, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
      console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      failures += 1;
      const text = error?.stack || error?.message || String(error);
      results.push({ name, ok: false, detail: text });
      console.log(`  FAIL  ${name} — ${text}`);
    }
    void started;
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  /**
   * Run a script inside the renderer and surface its errors as plain data
   * (Electron loses the message when a promise rejects).
   */
  async function inRenderer(body) {
    const result = await win.webContents.executeJavaScript(
      `(async () => { try { ${body} } catch (error) {
         return { __error: (error && error.message) || String(error),
                  __stack: (error && error.stack) || '' };
       } })()`,
    );
    if (result && result.__error) {
      throw new Error(`${result.__error}${result.__stack ? `\n${result.__stack}` : ''}`);
    }
    return result;
  }

  /** Wait until `needle` shows up in the captured process output. */
  async function waitForOutput(needle, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((state.testOutput || '').includes(needle)) return state.testOutput;
      await sleep(120);
    }
    throw new Error(`Timed out waiting for "${needle}". Captured: ${JSON.stringify((state.testOutput || '').slice(-400))}`);
  }

  console.log('\n=== Codes 0.2 self test ===\n');

  /* ---------------------------------------------------------------- */

  await test('Welcome screen is shown when no project is open', async () => {
    const visible = await inRenderer(`
      return !document.getElementById('welcome').classList.contains('welcome--hidden');
    `);
    assert(visible, 'welcome screen is not visible on a fresh start');

    const image = await win.webContents.capturePage();
    const target = path.join(app.getPath('temp'), 'codes-welcome.png');
    fs.writeFileSync(target, image.toPNG());
    return target;
  });

  await test('Renderer boots and CodeMirror is mounted', async () => {
    const info = await win.webContents.executeJavaScript(`(() => ({
      hasApi: typeof window.codesAPI === 'object',
      editor: !!document.querySelector('.cm-editor'),
      contentEditable: !!document.querySelector('.cm-content'),
      welcomeVisible: !document.getElementById('welcome').classList.contains('welcome--hidden'),
      tabBar: !!document.getElementById('tabs-list'),
      terminal: !!document.querySelector('.terminal'),
      os: document.getElementById('os-badge').textContent,
    }))()`);

    assert(info.hasApi, 'window.codesAPI is missing');
    assert(info.editor, 'CodeMirror editor was not created');
    assert(info.contentEditable, 'CodeMirror content area is missing');
    assert(info.terminal, 'terminal view is missing');
    return `editor mounted, os=${info.os}`;
  });

  await test('No renderer errors', async () => {
    const errors = state.rendererErrors || [];
    assert(errors.length === 0, `console errors: ${errors.join(' | ')}`);
    return 'clean console';
  });

  await test('Filesystem bridge: write / read / list / rename / delete', async () => {
    const script = `(async () => {
      const api = window.codesAPI;
      const dir = ${JSON.stringify(workspace)};
      const file = dir + '\\\\bridge-test.txt';

      const created = await api.fs.createFile(dir, 'bridge-test.txt');
      if (!created.ok) throw new Error('createFile: ' + created.error);

      const written = await api.fs.write(file, 'Merhaba Codes');
      if (!written.ok) throw new Error('write: ' + written.error);

      const read = await api.fs.read(file);
      if (!read.ok) throw new Error('read: ' + read.error);
      if (read.data.content !== 'Merhaba Codes') throw new Error('unexpected content: ' + read.data.content);

      const listed = await api.fs.list(dir);
      if (!listed.ok) throw new Error('list: ' + listed.error);
      if (!listed.data.some((e) => e.name === 'bridge-test.txt')) throw new Error('file missing from listing');

      const renamed = await api.fs.rename(file, dir + '\\\\renamed.txt');
      if (!renamed.ok) throw new Error('rename: ' + renamed.error);

      const removed = await api.fs.remove(dir + '\\\\renamed.txt');
      if (!removed.ok) throw new Error('remove: ' + removed.error);

      const stillThere = await api.fs.exists(dir + '\\\\renamed.txt');
      if (stillThere.data !== false) throw new Error('file was not deleted');

      const folder = await api.fs.createFolder(dir, 'made-folder');
      if (!folder.ok) throw new Error('createFolder: ' + folder.error);
      await api.fs.remove(folder.data.path);

      return 'all fs operations succeeded';
    })()`;
    const result = await win.webContents.executeJavaScript(script);
    return result;
  });

  await test('CMD session executes real commands', async () => {
    state.testOutput = '';
    const result = await win.webContents.executeJavaScript(`(async () => {
      const started = await window.codesAPI.terminal.start('cmd', ${JSON.stringify(workspace)});
      if (!started.ok) throw new Error(started.error);
      window.__testCmdId = started.data.id;
      await window.codesAPI.terminal.write(started.data.id, 'echo CODES_CMD_OK\\r\\n');
      return started.data.id;
    })()`);
    void result;
    await waitForOutput('CODES_CMD_OK');
    await win.webContents.executeJavaScript(`window.codesAPI.terminal.kill(window.__testCmdId)`);
    return 'echo round trip through cmd.exe';
  });

  await test('CMD session keeps Turkish and Azerbaijani characters intact', async () => {
    state.testOutput = '';
    await win.webContents.executeJavaScript(`(async () => {
      const started = await window.codesAPI.terminal.start('cmd', ${JSON.stringify(workspace)});
      window.__testCmdId2 = started.data.id;
      await window.codesAPI.terminal.write(started.data.id, 'echo CODES_UTF8_Maşalla_Əə_şükr\\r\\n');
    })()`);
    await waitForOutput('CODES_UTF8_Maşalla_Əə_şükr');
    await win.webContents.executeJavaScript(`window.codesAPI.terminal.kill(window.__testCmdId2)`);
    return 'UTF-8 round trip clean';
  });

  await test('PowerShell session executes real commands', async () => {
    state.testOutput = '';
    await win.webContents.executeJavaScript(`(async () => {
      const started = await window.codesAPI.terminal.start('powershell', ${JSON.stringify(workspace)});
      window.__testPsId = started.data.id;
      await window.codesAPI.terminal.write(started.data.id, 'Write-Output CODES_PS_OK\\r\\n');
    })()`);
    await waitForOutput('CODES_PS_OK');
    await win.webContents.executeJavaScript(`window.codesAPI.terminal.kill(window.__testPsId)`);
    return 'Write-Output round trip through powershell.exe';
  });

  await test('Running a JavaScript file with Node.js', async () => {
    state.testOutput = '';
    const scriptPath = path.join(workspace, 'hello.js');
    await fsp.writeFile(
      scriptPath,
      'console.log("Hello Codes");\nconsole.log("Merhaba Dünya");\n',
      'utf8',
    );

    const run = await win.webContents.executeJavaScript(`(async () => {
      const result = await window.codesAPI.process.runJs(${JSON.stringify(scriptPath)}, ${JSON.stringify(workspace)});
      if (!result.ok) throw new Error(result.error);
      window.__testRunId = result.data.id;
      return result.data.id;
    })()`);
    void run;

    await waitForOutput('Hello Codes');
    await waitForOutput('Merhaba Dünya');
    return 'node hello.js produced the expected output';
  });

  await test('Explorer lists the project tree', async () => {
    const result = await inRenderer(`
      await window.__codes.openProject(${JSON.stringify(workspace)});
      await new Promise((r) => setTimeout(r, 800));
      return [...document.querySelectorAll('.tree-row__label')].map((n) => n.textContent);
    `);
    assert(Array.isArray(result), `explorer did not return a list: ${JSON.stringify(result)}`);
    assert(result.includes('hello.js'), `hello.js not in explorer: ${JSON.stringify(result)}`);
    assert(result.includes('src'), `src folder not in explorer: ${JSON.stringify(result)}`);
    return `${result.length} entries`;
  });

  await test('Terminal keyboard: typed line, single command echo, real output', async () => {
    // The project is open now, so the shell has been restarted in its folder.
    await sleep(1200);
    const result = await inRenderer(`
      const terminal = document.querySelector('.terminal:not(.terminal--hidden)');
      terminal.focus();
      const type = (key) => terminal.dispatchEvent(new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true,
      }));

      for (const character of 'echo UI_TYPED_OK') type(character);
      await new Promise((r) => setTimeout(r, 250));
      const typed = document.querySelector('.terminal__line--active')?.textContent || '';

      type('Enter');
      await new Promise((r) => setTimeout(r, 1500));
      const lines = [...document.querySelectorAll('.terminal__line')].map((n) => n.textContent);
      return { typed, lines };
    `);

    assert(result.typed.includes('UI_TYPED_OK'), `typed text not visible: "${result.typed}"`);
    assert(
      result.typed.includes(path.basename(workspace)),
      `prompt does not show the project folder: "${result.typed}"`,
    );

    const commandLines = result.lines.filter((line) => line.includes('echo UI_TYPED_OK'));
    assert(commandLines.length === 1, `command rendered ${commandLines.length} times (duplicate echo?)`);

    const outputLines = result.lines.filter(
      (line) => line.includes('UI_TYPED_OK') && !line.includes('echo'),
    );
    assert(outputLines.length === 1, `expected exactly one output line, got ${outputLines.length}`);
    return `prompt + command + output rendered correctly`;
  });

  await test('Terminal keyboard: backspace and history', async () => {
    const result = await inRenderer(`
      const terminal = document.querySelector('.terminal:not(.terminal--hidden)');
      terminal.focus();
      const type = (key) => terminal.dispatchEvent(new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true,
      }));

      type('d'); type('i'); type('r');
      type('Backspace');
      await new Promise((r) => setTimeout(r, 150));
      const afterBackspace = document.querySelector('.terminal__line--active')?.textContent || '';

      type('ArrowUp');
      await new Promise((r) => setTimeout(r, 150));
      const afterHistory = document.querySelector('.terminal__line--active')?.textContent || '';
      return { afterBackspace, afterHistory };
    `);

    assert(result.afterBackspace.endsWith('di'), `backspace failed: "${result.afterBackspace}"`);
    assert(
      result.afterHistory.includes('echo UI_TYPED_OK'),
      `history did not restore the last command: "${result.afterHistory}"`,
    );
    return 'backspace and command history work';
  });

  await test('Editor opens a file with syntax highlighting', async () => {
    const result = await inRenderer(`
      await window.__codes.openFile(${JSON.stringify(path.join(workspace, 'hello.js'))});
      await new Promise((r) => setTimeout(r, 600));
      const text = document.querySelector('.cm-content')?.textContent || '';
      const spans = document.querySelectorAll('.cm-content span').length;
      const tab = document.querySelector('.tab__name')?.textContent || '';
      return { text, spans, tab };
    `);
    assert(result.text.includes('Hello Codes'), 'file content was not loaded into the editor');
    assert(result.spans > 3, 'no highlighted tokens were produced');
    assert(result.tab === 'hello.js', `tab label is "${result.tab}"`);
    return `${result.spans} highlighted tokens, tab "${result.tab}"`;
  });

  await test('Save writes the file back to disk', async () => {
    await inRenderer(`
      await window.__codes.commands.execute('file.save');
      await new Promise((r) => setTimeout(r, 500));
      return true;
    `);
    const content = await fsp.readFile(path.join(workspace, 'hello.js'), 'utf8');
    assert(content.includes('Hello Codes'), 'file content was lost');
    return 'file saved to disk';
  });

  await test('Command palette opens and filters', async () => {
    const result = await inRenderer(`
      window.__codes.commands.execute('view.palette');
      await new Promise((r) => setTimeout(r, 300));
      const open = !document.getElementById('palette').hidden;
      const input = document.getElementById('palette-input');
      input.value = 'terminal';
      input.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 250));
      const items = [...document.querySelectorAll('.palette-item__label')].map((n) => n.textContent);
      document.getElementById('palette').hidden = true;
      return { open, items };
    `);
    assert(result.open, 'palette did not open');
    assert(result.items.length > 0, 'palette produced no results for "terminal"');
    return `${result.items.length} matches`;
  });

  await test('HTML preview loads in a separate window', async () => {
    const htmlPath = path.join(workspace, 'index.html');
    await fsp.writeFile(
      htmlPath,
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head>' +
        '<body><h1>Hello Codes</h1><script src="app.js"></script></body></html>',
      'utf8',
    );
    await fsp.writeFile(path.join(workspace, 'style.css'), 'body { font-family: sans-serif; }', 'utf8');
    await fsp.writeFile(path.join(workspace, 'app.js'), 'console.log("preview ok");', 'utf8');

    await inRenderer(`
      await window.__codes.openFile(${JSON.stringify(htmlPath)});
      await new Promise((r) => setTimeout(r, 400));
      await window.codesAPI.preview.open(${JSON.stringify(htmlPath)});
      return true;
    `);

    const deadline = Date.now() + 10000;
    let preview = null;
    while (Date.now() < deadline) {
      preview = state.previewWindow;
      if (preview && !preview.isDestroyed() && preview.webContents.getURL().startsWith('preview://')) break;
      await sleep(200);
    }
    assert(preview, 'preview window was not created');
    const url = preview.webContents.getURL();
    assert(url.startsWith('preview://local/'), `unexpected preview url: ${url}`);
    return url;
  });

  await test('Screenshot captured', async () => {
    await sleep(700);
    const image = await win.webContents.capturePage();
    const target = path.join(app.getPath('temp'), 'codes-selftest.png');
    fs.writeFileSync(target, image.toPNG());
    return target;
  });

  /* ---------------------------------------------------------------- */

  console.log('\n--- summary ---');
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
  console.log(failures === 0 ? 'SELF TEST OK\n' : `SELF TEST FAILED (${failures})\n`);

  // Stop the shells first: a running process keeps the folder locked.
  try {
    await inRenderer(`
      const session = window.__codes.terminals.activeSession;
      if (session && session.id) await window.codesAPI.terminal.kill(session.id);
      return true;
    `);
  } catch {
    /* ignore */
  }
  shutdownSessions?.();
  await sleep(500);

  try {
    await fsp.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // The temp folder may stay behind; it is harmless.
  }

  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 400);
}

module.exports = { runSelfTest };
