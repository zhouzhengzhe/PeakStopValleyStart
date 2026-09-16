/**
 * Run every test file in `test/`, sequentially.
 *
 * The point of this script is what it does *not* contain: a list of file names. The suite
 * used to be a hand-written chain in `package.json`, and it silently fell four files behind
 * — the entire usage-ledger and info-bar feature had tests that `npm test` never executed,
 * which is worse than having none, because a green run claimed coverage that did not exist.
 *
 * Discovery means a new `test/*.test.mjs` is in the suite the moment it is created. There is
 * no list to forget to update.
 *
 * `stdio: 'inherit'` is deliberate: each file prints its own per-case lines, and inheriting
 * avoids capturing a child's output through a pipe.
 *
 * @module peak-valley-brake/scripts/run-tests
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');

const files = (await readdir(testDir)).filter((name) => name.endsWith('.test.mjs')).sort();

if (files.length === 0) {
  process.stderr.write(`no *.test.mjs files found in ${testDir}\n`);
  process.exit(1);
}

/** @type {string[]} */
const failed = [];

for (const name of files) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(testDir, name)], { stdio: 'inherit' });
    child.on('close', (value) => resolve(value ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) failed.push(name);
}

process.stdout.write(`\n${files.length} files run, ${failed.length} failed\n`);
if (failed.length > 0) {
  process.stdout.write(`failing: ${failed.join(', ')}\n`);
  process.exitCode = 1;
}
