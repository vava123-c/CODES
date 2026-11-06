/**
 * Codes 0.2 - HTML preview.
 *
 * The preview is rendered in a separate BrowserWindow that loads the project
 * through the `preview://` protocol. Because it is a real web origin, relative
 * resources (style.css, app.js) and ES modules work exactly like in a browser.
 */

/** @param {string} filePath */
export function isPreviewable(filePath) {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

export function createPreview({ api, onStatus, onError }) {
  let currentFile = null;
  let open = false;

  async function show(filePath) {
    if (!isPreviewable(filePath)) {
      onError?.('Preview is only available for HTML files.');
      return false;
    }
    const response = await api.preview.open(filePath);
    if (!response.ok) {
      onError?.(response.error);
      return false;
    }
    currentFile = filePath;
    open = true;
    onStatus?.();
    return true;
  }

  async function reload() {
    if (!open) return;
    await api.preview.reload();
  }

  async function close() {
    await api.preview.close();
    open = false;
    onStatus?.();
  }

  async function toggle(filePath) {
    if (open && currentFile === filePath) {
      await close();
      return false;
    }
    return show(filePath);
  }

  return {
    show,
    reload,
    close,
    toggle,
    get isOpen() {
      return open;
    },
    get file() {
      return currentFile;
    },
  };
}
