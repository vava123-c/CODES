/**
 * Creates Codes_0.2.zip next to the project.
 *
 * node_modules and temporary files are excluded so the archive stays small;
 * START_CODES.bat installs the dependencies on the first run.
 *
 * The archive always contains a single top level "Codes" folder, no matter how
 * the project folder itself is named.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const parent = dirname(projectRoot);
const output = join(parent, 'Codes_0.2.zip');
const staging = join(parent, '.codes-zip-staging');
const archiveName = 'Codes';

const EXCLUDED = new Set(['node_modules', '.git', '.idea', '.vscode']);

if (existsSync(output)) rmSync(output, { force: true });
if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });

/* Stage the sources under a clean "Codes" folder. */
const staged = join(staging, archiveName);
mkdirSync(staged, { recursive: true });

cpSync(projectRoot, staged, {
  recursive: true,
  filter: (source) => {
    const name = source.split(/[\\/]/).pop();
    return !EXCLUDED.has(name) && !name.endsWith('.log');
  },
});

/* Zip it. */
const args = ['-a', '-c', '-f', output, '-C', staging, archiveName];
const result = spawnSync('tar', args, { stdio: 'inherit' });

if (result.status !== 0) {
  console.error('tar failed, falling back to Compress-Archive...');
  const fallback = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(staging, archiveName)}' -DestinationPath '${output}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (fallback.status !== 0) {
    console.error('Could not create the archive.');
    process.exit(1);
  }
}

/* Clean up the staging folder. */
rmSync(staging, { recursive: true, force: true });

console.log(`Created ${output}`);
