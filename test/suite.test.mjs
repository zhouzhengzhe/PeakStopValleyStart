/**
 * Self-check for the suite itself.
 *
 * Run with `node test/suite.test.mjs`.
 *
 * This guards the one thing that let four test files go unrun without anything turning red:
 * the suite was a hand-written list of file names in `package.json`. A list that nobody
 * re-checks is a silent off-switch for tests, and a test suite that quietly stops covering
 * something is more dangerous than a small one, because the green line reads the same.
 *
 * The assertion is deliberately about the *shape* of the command, not about which files
 * exist: the runner discovers files, so file existence needs no assertion. What needs
 * pinning is that nobody reintroduces a list.
 *
 * @module peak-valley-brake/test/suite
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
 * @param {string} name - the case name.
 * @param {() => void} body - assertions to run.
 * @returns {void}
 */
function test(name, body) {
  try {
    body();
    results.passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const testScript = String(pkg.scripts?.test ?? '');
const files = (await readdir(join(root, 'test'))).filter((name) => name.endsWith('.test.mjs'));
// Read here rather than inside the case: the harness is synchronous, so an async body would
// let a failed assertion escape as an unhandled rejection instead of being reported.
const runner = await readFile(join(root, 'scripts', 'run-tests.mjs'), 'utf8');

process.stdout.write('\nthe test suite runs every test file\n');

test('S1 the test command discovers files instead of listing them', () => {
  assert.doesNotMatch(
    testScript,
    /\.test\.mjs/,
    'package.json "test" must not name individual test files; it must invoke scripts/run-tests.mjs, which discovers them',
  );
});

test('S2 the test command invokes the discovery runner', () => {
  assert.match(testScript, /scripts\/run-tests\.mjs/);
});

test('S3 the runner discovers test files by suffix, not by name', () => {
  assert.match(runner, /endsWith\('\.test\.mjs'\)/, 'the runner must discover by suffix');
  assert.doesNotMatch(runner, /'[a-z-]+\.test\.mjs'/, 'the runner must not contain a list of test file names');
});

test('S4 there is more than one test file, so discovery is actually doing work', () => {
  assert.ok(files.length > 5, `expected several test files, found ${files.length}`);
  assert.ok(files.includes('suite.test.mjs'));
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
