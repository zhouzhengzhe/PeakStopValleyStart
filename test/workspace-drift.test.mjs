/**
 * Self-check for workspace drift detection.
 *
 * Run with `node test/workspace-drift.test.mjs`.
 *
 * The suite builds real temporary git repositories, because the whole point of
 * this module is how it reads real repository state — a mocked git would test
 * the mock. Each repository is created inside the OS temp directory and removed
 * afterwards, so nothing outside the temp directory is touched.
 *
 * git is invoked with an explicit committer identity and `-c commit.gpgsign=false`
 * so the suite does not depend on the developer's global git configuration, and
 * it skips itself with a clear message if git is unavailable rather than failing.
 *
 * @module peak-valley-brake/test/workspace-drift
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  captureFingerprint,
  changedPaths,
  compareFingerprints,
  parsePorcelainPaths,
  renderDriftReport,
} from '../lib/workspace-drift.js';
import { dictionaryFor } from '../lib/messages.js';

const run = promisify(execFile);
const results = { passed: 0, failed: 0, skipped: 0 };

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

process.stdout.write('peak-valley-brake workspace drift\n\n');

let gitAvailable = true;
try {
  await run('git', ['--version'], { timeout: 10_000, windowsHide: true });
} catch {
  gitAvailable = false;
}

if (!gitAvailable) {
  process.stdout.write('  SKIP git is not available on PATH; the repository cases cannot run\n');
  process.stdout.write('\n0 passed, 0 failed (skipped)\n');
  process.exit(0);
}

/**
 * Create a temporary git repository with one committed file.
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>} the repository.
 */
async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'pvb-drift-'));
  const git = (args) =>
    run('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=pvb@example.invalid', '-c', 'user.name=pvb', ...args], {
      cwd: dir,
      timeout: 20_000,
      windowsHide: true,
    });
  await git(['init', '-q']);
  await writeFile(join(dir, 'tracked.txt'), 'original\n', 'utf8');
  await git(['add', 'tracked.txt']);
  await git(['commit', '-q', '-m', 'initial']);
  return {
    dir,
    git,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

process.stdout.write('\nporcelain parsing\n');

await test('parsePorcelainPaths reads untracked, modified, and staged entries', () => {
  const porcelain = ['?? new.txt', ' M edited.txt', 'M  staged.txt', 'A  added.txt', ' D gone.txt'].join('\n');
  assert.deepEqual(parsePorcelainPaths(porcelain), ['added.txt', 'edited.txt', 'gone.txt', 'new.txt', 'staged.txt']);
});

await test('parsePorcelainPaths keeps the destination of a rename', () => {
  assert.deepEqual(parsePorcelainPaths('R  old.txt -> new.txt'), ['new.txt']);
});

await test('parsePorcelainPaths strips git quoting around a path with spaces', () => {
  assert.deepEqual(parsePorcelainPaths('?? "a file with spaces.txt"'), ['a file with spaces.txt']);
});

await test('parsePorcelainPaths ignores blank lines and carriage returns', () => {
  assert.deepEqual(parsePorcelainPaths('\r\n?? a.txt\r\n\r\n'), ['a.txt']);
});

process.stdout.write('\nfingerprints of a real repository\n');

await test('a clean repository fingerprints as git-backed', async () => {
  const repo = await createRepo();
  try {
    const fingerprint = await captureFingerprint(repo.dir);
    assert.equal(fingerprint.kind, 'git');
    assert.match(fingerprint.head, /^[0-9a-f]{40}$/u, 'HEAD must be a full commit id');
    assert.match(fingerprint.statusDigest, /^[0-9a-f]{64}$/u);
    assert.equal(typeof fingerprint.measuredAtMs, 'number');
  } finally {
    await repo.cleanup();
  }
});

await test('two fingerprints of an untouched repository compare as unchanged', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    const after = await captureFingerprint(repo.dir);
    const comparison = compareFingerprints(before, after);
    assert.equal(comparison.status, 'unchanged');
    assert.deepEqual(comparison.reasons, []);
  } finally {
    await repo.cleanup();
  }
});

await test('repeated measurement never manufactures drift', async () => {
  // Regression guard. An earlier implementation folded `.git/index`'s mtime into
  // the fingerprint, but `git status` refreshes that file as a side effect, so
  // two measurements of a pristine repository disagreed and every release
  // reported drift. Ten consecutive measurements must agree.
  const repo = await createRepo();
  try {
    const first = await captureFingerprint(repo.dir);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = await captureFingerprint(repo.dir);
      assert.equal(
        compareFingerprints(first, next).status,
        'unchanged',
        `measurement ${attempt + 1} reported drift on an untouched repository`,
      );
    }
  } finally {
    await repo.cleanup();
  }
});

await test('the fingerprint records no filesystem mtime that git itself perturbs', async () => {
  const repo = await createRepo();
  try {
    const fingerprint = await captureFingerprint(repo.dir);
    assert.deepEqual(
      Object.keys(fingerprint).sort(),
      ['head', 'kind', 'measuredAtMs', 'statusDigest'],
      'adding a stat-based field here reintroduces the false-drift bug',
    );
  } finally {
    await repo.cleanup();
  }
});

await test('editing a tracked file is detected as drift', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await writeFile(join(repo.dir, 'tracked.txt'), 'edited by a human\n', 'utf8');
    const after = await captureFingerprint(repo.dir);
    const comparison = compareFingerprints(before, after);
    assert.equal(comparison.status, 'drifted');
    assert.ok(comparison.reasons.some((reason) => reason.code === 'status-changed'));
  } finally {
    await repo.cleanup();
  }
});

await test('a new untracked file is detected as drift', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await writeFile(join(repo.dir, 'brand-new.txt'), 'new work\n', 'utf8');
    const after = await captureFingerprint(repo.dir);
    assert.equal(compareFingerprints(before, after).status, 'drifted');
  } finally {
    await repo.cleanup();
  }
});

await test('a new file inside a new directory is detected as drift', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await mkdir(join(repo.dir, 'nested'), { recursive: true });
    await writeFile(join(repo.dir, 'nested', 'deep.txt'), 'deep\n', 'utf8');
    const after = await captureFingerprint(repo.dir);
    assert.equal(compareFingerprints(before, after).status, 'drifted');
  } finally {
    await repo.cleanup();
  }
});

await test('deleting a tracked file is detected as drift', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await unlink(join(repo.dir, 'tracked.txt'));
    const after = await captureFingerprint(repo.dir);
    assert.equal(compareFingerprints(before, after).status, 'drifted');
  } finally {
    await repo.cleanup();
  }
});

await test('staging a change is detected even when the commit is unchanged', async () => {
  const repo = await createRepo();
  try {
    await writeFile(join(repo.dir, 'second.txt'), 'staged work\n', 'utf8');
    const before = await captureFingerprint(repo.dir);
    await repo.git(['add', 'second.txt']);
    const after = await captureFingerprint(repo.dir);
    const comparison = compareFingerprints(before, after);
    assert.equal(comparison.status, 'drifted', 'a git add must be visible as drift');
    assert.equal(before.head, after.head, 'the commit itself did not move');
  } finally {
    await repo.cleanup();
  }
});

await test('a new commit is detected as drift', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await writeFile(join(repo.dir, 'tracked.txt'), 'committed\n', 'utf8');
    await repo.git(['add', 'tracked.txt']);
    await repo.git(['commit', '-q', '-m', 'a change made while held']);
    const after = await captureFingerprint(repo.dir);
    const comparison = compareFingerprints(before, after);
    assert.equal(comparison.status, 'drifted');
    assert.ok(comparison.reasons.some((reason) => reason.code === 'commit-changed'));
  } finally {
    await repo.cleanup();
  }
});

process.stdout.write('\nchanged path reporting\n');

await test('changedPaths names the files that moved, and only those', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await writeFile(join(repo.dir, 'tracked.txt'), 'edited\n', 'utf8');
    await writeFile(join(repo.dir, 'added.txt'), 'added\n', 'utf8');
    const after = await captureFingerprint(repo.dir);
    assert.deepEqual(await changedPaths(repo.dir, before, after), ['added.txt', 'tracked.txt']);
  } finally {
    await repo.cleanup();
  }
});

await test('changedPaths reports nothing when the status digest is unchanged', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    const after = await captureFingerprint(repo.dir);
    assert.deepEqual(await changedPaths(repo.dir, before, after), []);
  } finally {
    await repo.cleanup();
  }
});

await test('paths are repository-relative, never absolute', async () => {
  const repo = await createRepo();
  try {
    const before = await captureFingerprint(repo.dir);
    await writeFile(join(repo.dir, 'relative.txt'), 'x\n', 'utf8');
    const after = await captureFingerprint(repo.dir);
    const paths = await changedPaths(repo.dir, before, after);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], 'relative.txt');
    assert.ok(!paths[0].includes(repo.dir), 'no absolute path may be recorded');
  } finally {
    await repo.cleanup();
  }
});

process.stdout.write('\ndegraded paths\n');

await test('a directory that is not a repository fingerprints as unverified, not as an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pvb-norepo-'));
  try {
    await writeFile(join(dir, 'loose.txt'), 'x\n', 'utf8');
    const fingerprint = await captureFingerprint(dir);
    assert.equal(fingerprint.kind, 'unverified');
    assert.equal(fingerprint.note, 'not-a-repository', 'the note is a reason code the caller translates');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a missing directory fingerprints as unverified rather than throwing', async () => {
  const fingerprint = await captureFingerprint(join(tmpdir(), 'pvb-does-not-exist-9f3a'));
  assert.equal(fingerprint.kind, 'unverified');
});

await test('a session without a working directory is unverified and says so', async () => {
  const fingerprint = await captureFingerprint('');
  assert.equal(fingerprint.kind, 'unverified');
  assert.equal(fingerprint.note, 'no-working-directory', 'the note is a reason code the caller translates');
});

await test('a session with no working directory is distinguishable from an unverifiable one', async () => {
  // The brake stays silent when there is no workspace at all — there are no
  // files to go stale — but speaks up when a workspace exists and cannot be
  // checked. Both are `unverified`, so the note is what separates them.
  const absent = await captureFingerprint('');
  const dir = await mkdtemp(join(tmpdir(), 'pvb-norepo3-'));
  try {
    const unverifiable = await captureFingerprint(dir);
    assert.equal(absent.kind, 'unverified');
    assert.equal(unverifiable.kind, 'unverified');
    assert.notEqual(absent.note, unverifiable.note, 'the two situations must be told apart by their note');
    assert.equal(absent.note, 'no-working-directory');
    assert.ok(!/no working directory/u.test(unverifiable.note));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('an unverified workspace compares as unverified with a reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pvb-norepo2-'));
  try {
    const before = await captureFingerprint(dir);
    const after = await captureFingerprint(dir);
    const comparison = compareFingerprints(before, after);
    assert.equal(comparison.status, 'unverified');
    assert.ok(comparison.reasons.length > 0, 'an unverified result must explain itself');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a missing prior fingerprint compares as unverified rather than as unchanged', async () => {
  const repo = await createRepo();
  try {
    const after = await captureFingerprint(repo.dir);
    const comparison = compareFingerprints(undefined, after);
    assert.equal(comparison.status, 'unverified', 'unknown must never be reported as unchanged');
    assert.equal(comparison.reasons[0].code, 'no-fingerprint');
  } finally {
    await repo.cleanup();
  }
});

process.stdout.write('\nreport rendering\n');

await test('an unchanged comparison renders no report at all', () => {
  const rendered = renderDriftReport({ status: 'unchanged', reasons: [], paths: [] });
  assert.equal(rendered, undefined, 'nothing to say means nothing is injected');
});

await test('a drifted comparison names the reasons and the changed paths', () => {
  const rendered = renderDriftReport({
    status: 'drifted',
    reasons: [{ code: 'status-changed' }],
    paths: ['src/a.ts', 'src/b.ts'],
  });
  assert.match(rendered, /re-read the affected files/u);
  assert.match(rendered, /modified and untracked files changed/u);
  assert.match(rendered, /- src\/a\.ts/u);
  assert.match(rendered, /- src\/b\.ts/u);
});

await test('a commit-change reason names both commits', () => {
  const rendered = renderDriftReport({
    status: 'drifted',
    reasons: [{ code: 'commit-changed', before: 'aaaa1111', after: 'bbbb2222' }],
    paths: [],
  });
  assert.match(rendered, /aaaa1111/u);
  assert.match(rendered, /bbbb2222/u);
});

await test('drift with no listable paths tells the model to distrust earlier reads generally', () => {
  const rendered = renderDriftReport({
    status: 'drifted',
    reasons: [{ code: 'commit-changed', before: 'a', after: 'b' }],
    paths: [],
  });
  assert.match(rendered, /could not be listed/u);
  assert.match(rendered, /possibly stale/u);
});

await test('an unverified comparison asks for a re-read without claiming a change', () => {
  const rendered = renderDriftReport({
    status: 'unverified',
    reasons: [{ code: 'unmeasurable', note: 'not a git repository, or git is unavailable' }],
    paths: [],
  });
  assert.match(rendered, /could not be checked/u);
  assert.ok(!/changed while/u.test(rendered), 'an unverified result must not claim a change happened');
});

await test('the same report renders in Chinese when given the Chinese table', () => {
  const rendered = renderDriftReport(
    { status: 'drifted', reasons: [{ code: 'status-changed' }], paths: ['src/a.ts'] },
    dictionaryFor('zh'),
  );
  assert.match(rendered, /工作区发生了变更/u);
  assert.match(rendered, /- src\/a\.ts/u, 'paths stay verbatim: they are filesystem names');
  assert.ok(!/workspace changed/u.test(rendered), 'the English text must not leak through');
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
