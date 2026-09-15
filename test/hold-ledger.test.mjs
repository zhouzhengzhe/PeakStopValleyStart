/**
 * Self-check for the durable hold ledger.
 *
 * Run with `node test/hold-ledger.test.mjs`. The suite writes into a temporary
 * directory it creates and removes, never into the real harness home, so running
 * it cannot disturb a live session's parked work.
 *
 * @module peak-valley-brake/test/hold-ledger
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHoldLedger, harnessHome, summarizeMessage } from '../lib/hold-ledger.js';

const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
 * @param {string} name - the case name.
 * @param {() => Promise<void> | void} body - assertions to run.
 * @returns {Promise<void>} resolution after the case settles.
 */
async function test(name, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const home = await mkdtemp(join(tmpdir(), 'pvb-ledger-'));
const diagnostics = [];
const ledger = createHoldLedger({ home, report: (event) => diagnostics.push(event) });
const sessionId = 'session-6e0577de-b3ee-4e21-884b-208bd56393b8';

/** A batch fixture with two held messages. */
const batch = {
  sessionId,
  parkedAtMs: Date.parse('2026-09-15T01:58:00Z'),
  reason: 'peak',
  releaseAtMs: Date.parse('2026-09-15T04:01:00Z'),
  messages: [
    { id: 'message-1', role: 'user', source: 'user', summary: 'finish the parser' },
    { id: 'message-2', role: 'user', source: 'user', summary: 'then run the tests' },
  ],
};

process.stdout.write('peak-valley-brake hold ledger\n\n');

await test('a missing ledger reads as an empty result, not an error', async () => {
  const loaded = await ledger.load('session-never-parked');
  assert.deepEqual(loaded, { ok: true, batch: undefined });
});

await test('a saved batch round-trips with every field intact', async () => {
  const saved = await ledger.save(batch);
  assert.deepEqual(saved, { ok: true });
  const loaded = await ledger.load(sessionId);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.batch, batch);
});

await test('the document on disk carries its schema version', async () => {
  const raw = await readFile(join(home, 'peak-valley-brake', `${encodeURIComponent(sessionId)}.holds.json`), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessionId, sessionId);
});

await test('saving again replaces the previous batch rather than appending', async () => {
  await ledger.save({ ...batch, reason: 'pre-peak-brace', messages: [batch.messages[0]] });
  const loaded = await ledger.load(sessionId);
  assert.equal(loaded.batch.reason, 'pre-peak-brace');
  assert.equal(loaded.batch.messages.length, 1);
});

await test('clearing removes the batch and leaves a readable empty result', async () => {
  const cleared = await ledger.clear(sessionId);
  assert.deepEqual(cleared, { ok: true });
  const loaded = await ledger.load(sessionId);
  assert.deepEqual(loaded, { ok: true, batch: undefined });
});

await test('clearing twice is not an error', async () => {
  assert.deepEqual(await ledger.clear(sessionId), { ok: true });
});

await test('a malformed document degrades to empty and reports the fault', async () => {
  const file = join(home, 'peak-valley-brake', `${encodeURIComponent(sessionId)}.holds.json`);
  await writeFile(file, '{ this is not json', 'utf8');
  const before = diagnostics.length;
  const loaded = await ledger.load(sessionId);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'ledger-read-failed');
  assert.ok(diagnostics.length > before, 'the fault must be reported, not swallowed');
});

await test('an unsupported future version degrades instead of being guessed at', async () => {
  const file = join(home, 'peak-valley-brake', `${encodeURIComponent(sessionId)}.holds.json`);
  await writeFile(file, JSON.stringify({ version: 99, messages: [] }), 'utf8');
  const loaded = await ledger.load(sessionId);
  assert.equal(loaded.ok, false);
  assert.match(loaded.message, /unsupported ledger version/u);
});

await test('a document without a messages array is rejected', async () => {
  const file = join(home, 'peak-valley-brake', `${encodeURIComponent(sessionId)}.holds.json`);
  await writeFile(file, JSON.stringify({ version: 1 }), 'utf8');
  const loaded = await ledger.load(sessionId);
  assert.equal(loaded.ok, false);
});

await test('sessions are isolated from one another', async () => {
  await ledger.save({ ...batch, sessionId: 'session-a' });
  await ledger.save({ ...batch, sessionId: 'session-b', reason: 'peak' });
  const first = await ledger.load('session-a');
  const second = await ledger.load('session-b');
  assert.equal(first.batch.sessionId, 'session-a');
  assert.equal(second.batch.sessionId, 'session-b');
});

await test('concurrent saves settle without corrupting the file', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      ledger.save({ ...batch, reason: `attempt-${index}`, messages: [batch.messages[index % 2]] }),
    ),
  );
  const loaded = await ledger.load(sessionId);
  assert.equal(loaded.ok, true);
  assert.match(loaded.batch.reason, /^attempt-\d$/u);
});

await test('an explicit home wins and $DSH_HOME is read when it is absent', async () => {
  assert.equal(harnessHome({ DSH_HOME: 'D:\\custom-home' }), 'D:\\custom-home');
  assert.equal(harnessHome({ DSH_HOME: '   ' }).endsWith('.dsh'), true, 'a blank override falls back to ~/.dsh');
  assert.equal(harnessHome({}).endsWith('.dsh'), true);
});

process.stdout.write('\nreceipt summaries\n');

await test('summarizeMessage joins text blocks and collapses whitespace', () => {
  assert.equal(
    summarizeMessage({ content: [{ type: 'text', text: '  finish\n  the   parser ' }] }),
    'finish the parser',
  );
});

await test('summarizeMessage truncates a long prompt', () => {
  const summary = summarizeMessage({ content: [{ type: 'text', text: 'x'.repeat(400) }] });
  assert.equal(summary.length, 118);
  assert.ok(summary.endsWith('…'));
});

await test('summarizeMessage ignores non-text blocks instead of quoting them', () => {
  assert.equal(summarizeMessage({ content: [{ type: 'image' }] }), '(no text content)');
  assert.equal(summarizeMessage({}), '(no text content)');
});

process.stdout.write('\noverride audit trail\n');

await test('the audit trail is empty before anything is recorded', async () => {
  assert.deepEqual(await ledger.readOverrideAudit(), []);
});

await test('audit records append in order and survive a delivery', async () => {
  // The per-session ledger is deleted once work is delivered. The audit must not
  // live there, or the record of "who spent money at peak" would be erased by the
  // very delivery it describes.
  await ledger.appendOverrideAudit({ sessionId: 'session-x', kind: 'once', messagesReleased: 1 });
  await ledger.clear('session-x');
  await ledger.appendOverrideAudit({ sessionId: 'session-y', kind: 'window', messagesReleased: 3 });

  const audit = await ledger.readOverrideAudit();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].sessionId, 'session-x');
  assert.equal(audit[1].sessionId, 'session-y');
  assert.equal(audit[1].kind, 'window');
  assert.equal(audit[1].messagesReleased, 3);
});

await test('each audit record is stamped with its own time', async () => {
  const audit = await ledger.readOverrideAudit();
  for (const record of audit) assert.equal(typeof record.atMs, 'number');
});

await test('readOverrideAudit returns the most recent records up to the limit', async () => {
  const recent = await ledger.readOverrideAudit(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].sessionId, 'session-y', 'the newest record must be the one kept');
});

await test('a malformed audit line is skipped without losing the good ones', async () => {
  const file = join(home, 'peak-valley-brake', 'overrides.ndjson');
  const good = await readFile(file, 'utf8');
  await writeFile(file, `${good}{ this is not json\n${JSON.stringify({ sessionId: 'session-z', kind: 'once' })}\n`, 'utf8');
  const audit = await ledger.readOverrideAudit(50);
  assert.ok(audit.some((record) => record.sessionId === 'session-y'), 'earlier records must survive');
  assert.ok(audit.some((record) => record.sessionId === 'session-z'), 'records after the bad line must survive');
  assert.ok(diagnostics.some((event) => event.code === 'override-audit-line-skipped'));
});

await test('an audit write into an unusable location reports instead of throwing', async () => {
  const blocked = createHoldLedger({ home: join(home, 'a-file', 'nested') });
  await writeFile(join(home, 'a-file'), 'not a directory', 'utf8');
  const outcome = await blocked.appendOverrideAudit({ sessionId: 'session-blocked' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'override-audit-failed');
});

await rm(home, { recursive: true, force: true });

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
