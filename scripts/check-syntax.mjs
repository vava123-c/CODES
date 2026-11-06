/**
 * Syntax check for the renderer ES modules.
 * Parses every module with Node's VM module parser (no execution, no imports
 * resolved) so syntax errors are reported before Electron is even started.
 *
 * Usage: node --experimental-vm-modules scripts/check-syntax.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

const modules = readdirSync(srcDir).filter((file) => file.endsWith('.js'));
let failures = 0;

for (const file of modules) {
  const full = join(srcDir, file);
  const source = readFileSync(full, 'utf8');
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(source, { identifier: full });
    console.log(`OK    ${file}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${file}`);
    console.log(`      ${error.message}`);
  }
}

console.log(failures === 0 ? '\nAll modules parsed cleanly.' : `\n${failures} module(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
