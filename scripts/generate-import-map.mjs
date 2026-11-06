/**
 * Generates the import map inside src/index.html.
 *
 * CodeMirror 6 is published as ESM that uses bare module specifiers
 * ("@codemirror/state", "@lezer/common", ...). A browser cannot resolve those
 * on its own, so every package that is reachable from the editor has to be
 * mapped onto its ESM entry point.
 *
 * This script walks the dependency graph starting from the packages the
 * renderer imports and rewrites the import map accordingly, so the map can
 * never drift away from the installed versions.
 *
 * Run: node scripts/generate-import-map.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');
const nodeModules = join(root, 'node_modules');
const indexPath = join(srcDir, 'index.html');

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Split "@scope/name/sub/path" into the package name and the sub path. */
function splitSpecifier(specifier) {
  if (!specifier.startsWith('@')) {
    const slash = specifier.indexOf('/');
    return slash === -1
      ? { name: specifier, sub: '' }
      : { name: specifier.slice(0, slash), sub: specifier.slice(slash + 1) };
  }
  const parts = specifier.split('/');
  return { name: parts.slice(0, 2).join('/'), sub: parts.slice(2).join('/') };
}

/** Resolve the ESM entry point of a package inside node_modules. */
function resolveEntry(name) {
  const packageDir = join(nodeModules, ...name.split('/'));
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let relative = null;

  const exportsField = manifest.exports;
  if (typeof exportsField === 'string') {
    relative = exportsField;
  } else if (exportsField && typeof exportsField === 'object') {
    const root_ = exportsField['.'] ?? exportsField;
    if (typeof root_ === 'string') {
      relative = root_;
    } else if (root_ && typeof root_ === 'object') {
      relative = root_.import ?? root_.module ?? root_.default ?? null;
      if (typeof relative !== 'string') relative = null;
    }
  }

  if (!relative) relative = manifest.module ? `./${manifest.module}` : `./${manifest.main || 'index.js'}`;
  if (!relative.startsWith('.')) relative = `./${relative}`;

  const entryPath = join(packageDir, relative);
  if (!existsSync(entryPath)) return null;

  return {
    name,
    entryPath,
    url: `/node_modules/${name}/${relative.replace(/^\.\//, '').split('\\').join('/')}`,
  };
}

/** Collect every bare specifier used by the JS files of a package. */
function collectBareSpecifiers(entryPath) {
  const specifiers = new Set();
  const directory = dirname(entryPath);
  const files = [];

  const collect = (path) => {
    files.push(path);
  };
  collect(entryPath);

  try {
    for (const name of readdirSyncSafe(directory)) {
      if (name.endsWith('.js')) collect(join(directory, name));
    }
  } catch {
    /* ignore unreadable directories */
  }

  const pattern = /(?:^|[;\s}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('http')) continue;
      specifiers.add(specifier);
    }
  }

  return specifiers;
}

function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Walk the graph
 * ------------------------------------------------------------------ */

const sources = ['editor.js', 'renderer.js', 'tabs.js', 'explorer.js', 'terminal.js', 'preview.js', 'commands.js'];
const roots = new Set();
const importPattern = /(?:^|[;\s}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;

for (const file of sources) {
  const source = readFileSync(join(srcDir, file), 'utf8');
  let match;
  importPattern.lastIndex = 0;
  while ((match = importPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier.startsWith('.')) continue;
    roots.add(splitSpecifier(specifier).name);
  }
}

const resolved = new Map();
const queue = [...roots];
const missing = new Set();

while (queue.length > 0) {
  const name = queue.shift();
  if (resolved.has(name) || missing.has(name)) continue;

  const entry = resolveEntry(name);
  if (!entry) {
    missing.add(name);
    continue;
  }
  resolved.set(name, entry);

  for (const specifier of collectBareSpecifiers(entry.entryPath)) {
    const dependency = splitSpecifier(specifier).name;
    if (!resolved.has(dependency) && !missing.has(dependency)) queue.push(dependency);
  }
}

if (missing.size > 0) {
  console.warn('Warning: could not resolve:', [...missing].join(', '));
}

/* ------------------------------------------------------------------ *
 * Rewrite index.html
 * ------------------------------------------------------------------ */

const entries = [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name));
const map = {};
for (const entry of entries) map[entry.name] = entry.url;

const json = JSON.stringify({ imports: map }, null, 2)
  .split('\n')
  .map((line, index) => (index === 0 ? line : `  ${line}`))
  .join('\n')
  .replace(/\n\}$/, '\n  }');

const html = readFileSync(indexPath, 'utf8');
const pattern = /<script type="importmap">[\s\S]*?<\/script>/;
if (!pattern.test(html)) {
  console.error('No inline import map found in src/index.html.');
  process.exit(1);
}

const updated = html.replace(pattern, `<script type="importmap">\n${json}\n    </script>`);

if (updated !== html) {
  writeFileSync(indexPath, updated, 'utf8');
  console.log(`Import map regenerated with ${entries.length} packages.`);
} else {
  console.log(`Import map already up to date (${entries.length} packages).`);
}
