/**
 * Codes 0.2 - Tab bar.
 *
 * Renders the open-file tabs, keeps the dirty marker in sync and reports
 * activation / close requests back to the application shell.
 */

const ICONS = {
  javascript: 'i-file-js',
  html: 'i-file-html',
  css: 'i-file-css',
};

export function createTabs({ container, onActivate, onClose }) {
  let tabs = [];
  let activePath = null;

  /** @param {Array<{path: string, name: string, languageId: string, dirty: boolean}>} list */
  function render(list, active) {
    tabs = list;
    activePath = active;
    container.textContent = '';

    for (const tab of tabs) {
      const element = document.createElement('div');
      element.className = 'tab';
      element.classList.toggle('tab--active', tab.path === activePath);
      element.dataset.path = tab.path;
      element.setAttribute('role', 'tab');
      element.setAttribute('aria-selected', String(tab.path === activePath));
      element.title = tab.path;

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#${ICONS[tab.languageId] || 'i-file'}`);
      icon.appendChild(use);
      icon.classList.add('tab__icon');
      if (ICONS[tab.languageId]) icon.classList.add(`tab__icon--${tab.languageId}`);
      element.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'tab__name';
      label.textContent = tab.name;
      element.appendChild(label);

      if (tab.dirty) {
        const dirty = document.createElement('span');
        dirty.className = 'tab__dirty';
        dirty.title = 'Unsaved changes';
        element.appendChild(dirty);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'tab__dirty';
        spacer.style.visibility = 'hidden';
        element.appendChild(spacer);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab__close';
      close.title = 'Close';
      close.setAttribute('aria-label', `Close ${tab.name}`);
      const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const closeUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      closeUse.setAttribute('href', '#i-close');
      closeIcon.appendChild(closeUse);
      close.appendChild(closeIcon);
      element.appendChild(close);

      element.addEventListener('mousedown', (event) => {
        // Middle click closes, like most editors.
        if (event.button === 1) {
          event.preventDefault();
          onClose(tab.path);
          return;
        }
        if (event.button !== 0) return;
        const target = event.target;
        if (target.closest('.tab__close')) return;
        onActivate(tab.path);
      });

      container.appendChild(element);
    }
  }

  return {
    render,
    get activePath() {
      return activePath;
    },
    get tabs() {
      return tabs;
    },
  };
}
