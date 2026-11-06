/**
 * Keeps the Content Security Policy in sync with the inline import map.
 *
 * The import map has to be an inline <script> (external import maps need a
 * newer Chromium than Electron 33 ships), so CSP blocks it unless the exact
 * content is allowed through a SHA-256 hash.
 *
 * Run after editing the import map:  node scripts/sync-csp.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, '..', 'src', 'index.html');

const html = readFileSync(indexPath, 'utf8');

const importMapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!importMapMatch) {
  console.error('No inline import map found in src/index.html.');
  process.exit(1);
}

const importMapSource = importMapMatch[1];
const hash = `sha256-${createHash('sha256').update(importMapSource, 'utf8').digest('base64')}`;

const cspPattern = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/;
const cspMatch = html.match(cspPattern);
if (!cspMatch) {
  console.error('No Content-Security-Policy meta tag found in src/index.html.');
  process.exit(1);
}

const directives = cspMatch[2]
  .split(';')
  .map((directive) => directive.trim())
  .filter(Boolean)
  .map((directive) => {
    const [name, ...values] = directive.split(/\s+/);
    if (name !== 'script-src') return directive;
    const cleaned = values.filter((value) => !/^'?sha256-/i.test(value));
    cleaned.push(`'${hash}'`);
    return [name, ...cleaned].join(' ');
  });

const updated = html.replace(cspPattern, `$1${directives.join('; ')};$3`);

if (updated !== html) {
  writeFileSync(indexPath, updated, 'utf8');
  console.log(`CSP updated: script-src now allows '${hash}'`);
} else {
  console.log(`CSP already up to date ('${hash}').`);
}
