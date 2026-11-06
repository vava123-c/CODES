/**
 * Codes 0.2 - Editor module.
 *
 * Wraps CodeMirror 6 with:
 *   - a Codes specific theme (not a VS Code look-alike),
 *   - language detection for JavaScript / HTML / CSS,
 *   - per-file EditorState so cursor position, selection and undo history
 *     survive tab switches,
 *   - application level key bindings (save, run, palette, terminal).
 */

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { searchKeymap, search, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

const codesHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: '#c792ea' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#f78c6c' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#5d6b82', fontStyle: 'italic' },
  { tag: [t.variableName], color: '#d6dceb' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.className, t.typeName, t.namespace], color: '#ffcb6b' },
  { tag: [t.tagName], color: '#f07178' },
  { tag: [t.attributeName], color: '#ffcb6b' },
  { tag: [t.propertyName], color: '#b2ccd6' },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator], color: '#89ddff' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#7e8ba3' },
  { tag: [t.meta, t.processingInstruction], color: '#7e8ba3' },
  { tag: [t.heading], color: '#82aaff', fontWeight: '700' },
  { tag: [t.link, t.url], color: '#4c8dff', textDecoration: 'underline' },
  { tag: [t.definition(t.variableName)], color: '#d6dceb' },
  { tag: [t.invalid], color: '#f2564d' },
]);

const codesTheme = EditorView.theme(
  {
    '&': {
      color: '#d6dceb',
      backgroundColor: '#0d121b',
      height: '100%',
      fontSize: '13px',
    },
    '.cm-content': {
      caretColor: '#4c8dff',
      padding: '10px 0 40vh',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeft: '2px solid #4c8dff',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(76, 141, 255, 0.26)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.032)' },
    '.cm-gutters': {
      backgroundColor: '#0d121b',
      borderRight: '1px solid #172031',
      color: '#626e83',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#1b2433',
      color: '#8b97ad',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px',
      minWidth: '40px',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(76, 141, 255, 0.18)',
      outline: '1px solid rgba(76, 141, 255, 0.4)',
      color: '#f0f4fb !important',
    },
    '.cm-nonmatchingBracket': { color: '#f2564d !important' },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(76, 141, 255, 0.18)',
      outline: '1px solid rgba(76, 141, 255, 0.3)',
    },
    '.cm-panels': {
      backgroundColor: '#161d2b',
      color: '#d6dceb',
      borderColor: '#1e2735',
    },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid #1e2735' },
    '.cm-panels input': {
      backgroundColor: '#0b1018',
      border: '1px solid #2b3648',
      borderRadius: '4px',
      color: '#f0f4fb',
      padding: '3px 7px',
    },
    '.cm-panels button': {
      backgroundColor: '#161d2b',
      border: '1px solid #2b3648',
      borderRadius: '4px',
      color: '#d6dceb',
      padding: '3px 8px',
    },
    '.cm-panels button:hover': { backgroundColor: '#1b2433' },
    '.cm-tooltip': {
      backgroundColor: '#161d2b',
      border: '1px solid #2b3648',
      borderRadius: '6px',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#4c8dff',
      color: '#ffffff',
    },
    '.cm-foldGutter span': { color: '#626e83' },
    '.cm-placeholder': { color: '#4d5768' },
  },
  { dark: true },
);

/* ------------------------------------------------------------------ *
 * Languages
 * ------------------------------------------------------------------ */

/**
 * Resolve the language support for a file.
 * @param {string} filePath
 * @returns {{id: string, label: string}}
 */
export function languageFor(filePath) {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();

  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return { id: 'javascript', label: 'JavaScript' };
    case '.html':
    case '.htm':
      return { id: 'html', label: 'HTML' };
    case '.css':
      return { id: 'css', label: 'CSS' };
    case '.json':
      return { id: 'json', label: 'JSON' };
    case '.md':
      return { id: 'markdown', label: 'Markdown' };
    default:
      return { id: 'plaintext', label: 'Plain Text' };
  }
}

/** CodeMirror extension used for a given language id. */
function languageExtension(languageId) {
  switch (languageId) {
    case 'javascript':
      return javascript({ jsx: true });
    case 'html':
      return html();
    case 'css':
      return css();
    case 'json':
      return json();
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Application key bindings
 * ------------------------------------------------------------------ */

/**
 * Build the Codes specific key bindings.
 * @param {(id: string) => void} onCommand
 */
function codesBindings(onCommand) {
  const command = (id) => () => {
    onCommand(id);
    return true;
  };

  return [
    { key: 'Mod-s', preventDefault: true, run: command('file.save') },
    { key: 'Mod-w', preventDefault: true, run: command('file.closeTab') },
    { key: 'Mod-p', preventDefault: true, run: command('view.quickOpen') },
    { key: 'Mod-Shift-p', preventDefault: true, run: command('view.palette') },
    { key: 'Mod-`', preventDefault: true, run: command('terminal.toggle') },
    { key: 'F5', preventDefault: true, run: command('run.runJs') },
    { key: 'Mod-Shift-f', preventDefault: true, run: command('edit.find') },
  ];
}

/* ------------------------------------------------------------------ *
 * Editor host
 * ------------------------------------------------------------------ */

/**
 * Create the CodeMirror host.
 *
 * @param {object} options
 * @param {HTMLElement} options.parent           container element
 * @param {(id: string) => void} options.onCommand application command dispatcher
 * @param {(state: EditorState) => void} options.onStateChange called after every update
 * @param {(info: {line: number, column: number, selected: number}) => void} options.onCursor
 */
export function createEditor({ parent, onCommand, onStateChange, onCursor }) {
  const bindings = codesBindings(onCommand);

  const build = (content, languageId) =>
    EditorState.create({
      doc: content,
      extensions: [
        codesTheme,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter({ openText: '▾', closedText: '▸' }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(codesHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, icons: false, defaultKeymap: true }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true, literal: true }),
        languageExtension(languageId),
        EditorView.contentAttributes.of({ 'aria-label': 'Code editor' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onStateChange?.(update.state);
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main;
            const line = update.state.doc.lineAt(head.head);
            onCursor?.({
              line: line.number,
              column: head.head - line.from + 1,
              selected: Math.abs(update.state.selection.to - update.state.selection.from),
            });
          }
        }),
        keymap.of([
          ...bindings,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
      ],
    });

  const view = new EditorView({
    parent,
    state: build('', 'plaintext'),
  });

  return {
    view,

    /** Swap in a previously stored state (tab switch). */
    setState(state) {
      view.setState(state);
    },

    /** Build a fresh state for a document. */
    createState(content, languageId) {
      return build(content, languageId);
    },

    focus() {
      view.focus();
    },

    /** Open the CodeMirror search panel. */
    openSearch() {
      openSearchPanel(view);
    },

    undo() {
      undo(view);
    },

    redo() {
      redo(view);
    },
  };
}
