/**
 * Self-check for the info bar's occupancy of the composer dock.
 *
 * Run with `node test/info-bar-slot.test.mjs`.
 *
 * The module cannot be imported here: it imports `react`, which the harness supplies
 * at runtime and this checkout deliberately does not vendor. So the contract is asserted
 * against the source text and the built bundle — the same approach `client-bundle.test.mjs`
 * takes, and for the same reason.
 *
 * The single most valuable assertion in this file is that the registered id is **not**
 * `stats`. The harness lays an entry with an id of its own *beside* the official
 * statistics row, but an entry reusing the official id *replaces* it. "Two rows" is a
 * decision that lives in one string literal, so a later edit — including a well-meaning
 * one that "unifies" the names — would silently delete the native row instead of
 * failing. That is what this file is for.
 *
 * @module peak-valley-brake/test/info-bar-slot
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const results = { passed: 0, failed: 0 };

/**
 * Run one named async case and record its outcome.
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

const source = await readFile(new URL('../lib/info-bar-slot.js', import.meta.url), 'utf8');
const bundle = await readFile(new URL('../lib/client.bundle.js', import.meta.url), 'utf8');

/**
 * Read a string constant's value out of the module source.
 * @param {string} name - the exported constant's name.
 * @returns {string} its literal value.
 */
function constantFromSource(name) {
  const match = new RegExp(`export const ${name} = '([^']*)'`, 'u').exec(source);
  assert.ok(match, `${name} must be a single-quoted string literal in info-bar-slot.js`);
  return match[1];
}

await test('the bar registers its own dock id, never the official "stats"', async () => {
  const id = constantFromSource('INFO_BAR_SLOT_ID');
  assert.notEqual(
    id,
    'stats',
    'reusing the official id replaces the native statistics row instead of sitting beside it',
  );
  assert.equal(id, 'peak-valley-info');
});

await test('the id the source declares is the id the bundle ships', async () => {
  // A source constant that never reached the build would leave the guard above
  // protecting a string the browser never sees.
  const id = constantFromSource('INFO_BAR_SLOT_ID');
  assert.ok(bundle.includes(id), `the built bundle must carry the slot id ${id}`);
});

await test('the bundle never registers the official stats id itself', async () => {
  // Catches the same mistake made through a literal instead of the constant.
  assert.doesNotMatch(
    bundle,
    /id:\s*['"]stats['"]/u,
    'the bundle must not register an entry with the official id',
  );
});

await test('the bar occupies the documented composer dock', async () => {
  assert.equal(constantFromSource('INFO_BAR_SLOT_NAME'), 'conversation.composer.dock');
});

await test('the bar sorts after the official row rather than before it', async () => {
  const match = /priority:\s*(-?\d+)/u.exec(source);
  assert.ok(match, 'the registration must declare a priority');
  assert.ok(
    Number(match[1]) < 0,
    'a negative priority is what puts the native statistics above our line, so the two read as session-then-cost',
  );
});

await test('a composition with no slots service reports it instead of throwing', async () => {
  // The module cannot be executed, so the guarantee is asserted structurally: the
  // registration path checks for the service and calls the warn sink rather than
  // letting a missing service escape. A silently missing bar is indistinguishable
  // from a broken one, which is why this must be reported.
  assert.match(source, /no slots service/u);
  assert.match(source, /typeof slots\.register !== 'function'/u);
});

await test('the countdown ticks locally instead of waiting for the next poll', async () => {
  // The host polls every few seconds; a countdown rendered only from polls would sit
  // frozen and then jump. Asserted here because losing the interval would look like a
  // stale clock rather than a missing feature.
  assert.match(source, /setInterval\(/u, 'the component must re-render on its own clock');
  assert.match(source, /clearInterval\(/u, 'the interval must be released on unmount');
  assert.match(source, /formatCountdown\(remaining\)/u, 'the recomputed text must use the host formatter');
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
process.exit(results.failed === 0 ? 0 : 1);
