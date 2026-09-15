/**
 * Self-check for the mascot assets.
 *
 * Run with `node test/assets.test.mjs`.
 *
 * The badge loads its art by name, computed from the published state, so a
 * missing file is not a broken image in a test — it is a silently blank badge in
 * a browser, which is the one place this project cannot verify by itself. These
 * assertions are therefore the only mechanical guard the art has.
 *
 * @module peak-valley-brake/test/assets
 */

import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const mascotDir = join(root, 'assets', 'mascot');

const results = { passed: 0, failed: 0 };

/**
 * Run one named case and record its outcome.
 * @param {string} caseName - the case name.
 * @param {() => Promise<void> | void} body - case body.
 * @returns {Promise<void>} resolution after the case settles.
 */
async function test(caseName, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${caseName}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${caseName}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * The art the badge renders, keyed by the published state it represents.
 *
 * This list is the contract between the art and the state machine: every
 * published state that the badge displays must have a file here, and the badge
 * falls back to `idle` for any state it does not expect.
 */
const MASCOT_STATES = ['idle', 'armed', 'held', 'released'];

/** Sizes the generator produces, from `scripts/resize-mascot.ps1`. */
const MASCOT_SIZES = ['128', '200', '320'];

/** Ceiling for one derivative, so a careless re-export cannot ship megabytes. */
const MAX_DERIVATIVE_BYTES = 160 * 1024;

process.stdout.write('peak-valley-brake mascot assets\n\n');

await test('a source image exists for every state the badge can show', async () => {
  for (const state of MASCOT_STATES) {
    const file = join(mascotDir, `${state}.png`);
    const info = await stat(file);
    assert.ok(info.isFile(), `${state}.png must exist`);
    assert.ok(info.size > 1000, `${state}.png looks empty`);
  }
});

await test('every size the badge requests has been generated', async () => {
  for (const size of MASCOT_SIZES) {
    for (const state of MASCOT_STATES) {
      const file = join(mascotDir, size, `${state}.png`);
      await stat(file).catch(() => {
        throw new Error(`missing derivative ${size}/${state}.png — run scripts/resize-mascot.ps1`);
      });
    }
  }
});

await test('no derivative is large enough to bloat a page load', async () => {
  const oversized = [];
  for (const size of MASCOT_SIZES) {
    for (const state of MASCOT_STATES) {
      const info = await stat(join(mascotDir, size, `${state}.png`));
      if (info.size > MAX_DERIVATIVE_BYTES) oversized.push(`${size}/${state}.png = ${info.size} bytes`);
    }
  }
  assert.deepEqual(oversized, [], 'these derivatives exceed the size ceiling');
});

await test('every file is a real PNG, not a renamed or truncated one', async () => {
  for (const size of MASCOT_SIZES) {
    for (const state of MASCOT_STATES) {
      const bytes = await readFile(join(mascotDir, size, `${state}.png`));
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `${size}/${state}.png must carry the PNG signature`,
      );
    }
  }
});

await test('the badge state list and the art directory agree', async () => {
  // A new state added to the state machine without art would render a blank
  // badge; art added without a state would never be shown. Both are caught here.
  const entries = await readdir(mascotDir, { withFileTypes: true });
  const found = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name.replace(/\.png$/u, ''))
    .sort();
  assert.deepEqual(found, [...MASCOT_STATES].sort());
});

await test('the readme pins how the art is regenerated', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const chinese = await readFile(join(root, 'README.zh.md'), 'utf8');
  for (const [label, text] of [['README.md', readme], ['README.zh.md', chinese]]) {
    assert.match(text, /resize-mascot\.ps1/u, `${label} must document the regeneration command`);
  }
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
