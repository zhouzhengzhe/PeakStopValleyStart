/**
 * Build the client bundle the harness serves.
 *
 * Why a build step exists at all: the harness serves one file that calls
 * `window.__ModuleLoader__.load({ id, factory })`, and inside that factory only
 * `require` exists — no ESM resolution, no relative paths. The badge's source is
 * three ordinary modules with relative imports, so something has to flatten them.
 *
 * Why esbuild: the client plugins already installed in this harness build with
 * it, so it is the ambient tool rather than a new dependency of this project's
 * own invention.
 *
 *   node scripts/build-client.mjs
 *
 * The output is committed. That is deliberate: the harness loads the file
 * directly, so it must exist without a build having been run, and its diff is the
 * honest record of what a browser will execute.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'lib', 'client.js');
const output = join(root, 'lib', 'client.bundle.js');

/**
 * Locate esbuild.
 *
 * It is not a dependency of this package — it ships inside the desktop app and
 * inside the client plugins that are already installed. Resolving it by name
 * first, then through the app, keeps this project from pinning a second copy of a
 * bundler it only uses to flatten three files.
 *
 * @returns {Promise<{build: Function, version: string}>} the esbuild module.
 */
async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    /* fall through to the copies that ship with the app */
  }
  const candidates = [
    join(root, 'node_modules', 'esbuild', 'lib', 'main.js'),
    join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'profiles', 'web', 'node_modules', 'esbuild', 'lib', 'main.js'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      const require = createRequire(import.meta.url);
      return require(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'esbuild was not found. Install it (npm i -D esbuild) or run this from a machine with the desktop app present.',
  );
}

const esbuild = await loadEsbuild();

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  globalName: '__peakValleyBrakeClient',
  platform: 'browser',
  target: ['es2020'],
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});

const bundled = result.outputFiles[0].text;

// The loader contract, taken from the client plugins already installed in this
// harness: a single call naming the plugin id and a factory that returns the
// module's exports. `require` is left in place for shared browser modules; this
// bundle needs none of them.
//
// Every export is forwarded rather than a hand-listed few: the harness reads
// `apply`, `inject` and `name`, and the test suite drives the rest — so a new
// export must not need this file edited to become reachable.
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-peak-valley-brake",
	factory: (require) => {
		var module = { exports: {} };
${indent(bundled, 2)}
		Object.assign(module.exports, __peakValleyBrakeClient);
		return module.exports;
	}
});
`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, wrapped, 'utf8');

process.stdout.write(`built ${output}\n`);
process.stdout.write(`  entry   ${entry}\n`);
process.stdout.write(`  bundle  ${bundled.length} bytes\n`);
process.stdout.write(`  wrapped ${wrapped.length} bytes\n`);

/**
 * Indent generated code so it reads as part of the wrapper.
 * @param {string} text - the code.
 * @param {number} spaces - indentation width.
 * @returns {string} the indented code.
 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${pad}${line}`))
    .join('\n');
}
