/**
 * Self-check for the brake's published state: the event vocabulary, the fold,
 * and the write-suppression rule.
 *
 * Run with `node test/hold-state.test.mjs`.
 *
 * The fold is where a client-visible bug would hide quietly: a fold that copies
 * state on unrelated events defeats the registry's change detection, and one
 * that trusts a malformed record corrupts the badge. Both are asserted here
 * rather than left to a browser to reveal.
 *
 * @module peak-valley-brake/test/hold-state
 */

import assert from 'node:assert/strict';

import {
  EMPTY_HOLD_STATE,
  HOLD_EVENT_TYPE,
  HOLD_PROJECTION_KEY,
  HOLD_STATE_VERSION,
  applyHoldEvent,
  holdProjectionDefinition,
  holdStateDiffers,
  holdStateFor,
  publishHoldState,
  releaseStateFor,
} from '../lib/hold-state.js';

const results = { passed: 0, failed: 0 };

/**
 * Run one named case and record its outcome.
 * @param {string} caseName - the case name.
 * @param {() => void} body - case body.
 * @returns {void}
 */
function test(caseName, body) {
  try {
    body();
    results.passed += 1;
    process.stdout.write(`  ok   ${caseName}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${caseName}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** A fixed instant, so nothing here depends on when it runs. */
const NOW = Date.parse('2026-09-15T02:00:00Z');

/** A well-formed hold state. */
const HOLD = holdStateFor({
  phase: 'peak',
  heldCount: 2,
  reason: 'peak',
  releaseAtMs: Date.parse('2026-09-15T04:01:00Z'),
  nowMs: NOW,
});

process.stdout.write('peak-valley-brake published hold state\n\n');

process.stdout.write('event vocabulary\n');

test('the event type is namespaced to this plugin', () => {
  assert.match(HOLD_EVENT_TYPE, /^peak-valley-brake\//u);
  assert.equal(HOLD_PROJECTION_KEY, 'peakValleyBrake');
  assert.equal(HOLD_STATE_VERSION, 1);
});

test('the projection definition carries every field the registry requires', () => {
  assert.equal(typeof holdProjectionDefinition.key, 'string');
  assert.equal(typeof holdProjectionDefinition.stateVersion, 'number');
  assert.equal(typeof holdProjectionDefinition.init, 'function');
  assert.equal(typeof holdProjectionDefinition.apply, 'function');
  assert.equal(typeof holdProjectionDefinition.stateSchema, 'object');
  assert.equal(typeof holdProjectionDefinition.wire.view, 'function');
  assert.equal(typeof holdProjectionDefinition.wire.viewSchema, 'object');
});

test('the definition is frozen, so a consumer cannot mutate the contract', () => {
  assert.ok(Object.isFrozen(holdProjectionDefinition));
});

process.stdout.write('\nthe fold\n');

test('init yields a state that says nothing is held', () => {
  const initial = holdProjectionDefinition.init();
  assert.equal(initial.engaged, false);
  assert.equal(initial.heldCount, 0);
  assert.equal(initial.reason, null);
  assert.equal(initial.overrideActive, false);
});

test('an unrelated event returns the same reference, not a copy', () => {
  // The registry compares with Object.is to skip downstream work; returning a
  // fresh object here would make every event in the session recompute the view.
  const same = applyHoldEvent(EMPTY_HOLD_STATE, { type: 'turn/start', data: {} });
  assert.equal(same, EMPTY_HOLD_STATE, 'an unrelated event must not allocate');
});

test('a hold event folds to exactly the published state', () => {
  const folded = applyHoldEvent(EMPTY_HOLD_STATE, { type: HOLD_EVENT_TYPE, data: HOLD });
  assert.deepEqual(folded, HOLD);
});

test('a malformed record keeps the previous state instead of corrupting the view', () => {
  const kept = applyHoldEvent(HOLD, { type: HOLD_EVENT_TYPE, data: { engaged: 'yes' } });
  assert.equal(kept, HOLD);
});

test('a record missing fields is rejected rather than partially applied', () => {
  const kept = applyHoldEvent(EMPTY_HOLD_STATE, { type: HOLD_EVENT_TYPE, data: { engaged: true } });
  assert.equal(kept, EMPTY_HOLD_STATE);
});

test('the fold is a pure replacement, so replay order is the only state', () => {
  const later = releaseStateFor({ phase: 'open', releaseReason: 'schedule', nowMs: NOW + 1000 });
  const first = applyHoldEvent(EMPTY_HOLD_STATE, { type: HOLD_EVENT_TYPE, data: HOLD });
  const second = applyHoldEvent(first, { type: HOLD_EVENT_TYPE, data: later });
  assert.deepEqual(second, later, 'the newest record wins whole');
});

test('the wire view is the state itself today', () => {
  const view = holdProjectionDefinition.wire.view(HOLD);
  assert.deepEqual(view, HOLD);
});

process.stdout.write('\nwrite suppression\n');

test('an identical state is not written again', () => {
  assert.equal(holdStateDiffers(HOLD, { ...HOLD, updatedAtMs: NOW + 5000 }), false);
});

test('every observable field counts as a difference', () => {
  const mutations = {
    engaged: false,
    phase: 'open',
    heldCount: 3,
    reason: 'pre-peak-brace',
    releaseAtMs: null,
    lastReleaseReason: 'override',
    overrideActive: true,
    overrideUntilMs: NOW,
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.equal(holdStateDiffers(HOLD, { ...HOLD, [field]: value }), true, `${field} must count as a change`);
  }
});

test('a missing previous state always writes', () => {
  assert.equal(holdStateDiffers(undefined, HOLD), true);
});

test('publishing writes once and then stays silent while nothing changes', () => {
  const written = [];
  const session = { append: (type, data) => written.push({ type, data }) };
  const first = publishHoldState(session, HOLD, undefined);
  assert.equal(first.written, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].type, HOLD_EVENT_TYPE);

  const second = publishHoldState(session, { ...HOLD, updatedAtMs: NOW + 60_000 }, first.state);
  assert.equal(second.written, false, 'a timestamp-only change must not write');
  assert.equal(written.length, 1, 'the log must not gain a duplicate record');
});

test('a refused append is reported and leaves the published state untouched', () => {
  const session = {
    append: () => {
      throw new Error('session closed');
    },
  };
  const outcome = publishHoldState(session, HOLD, undefined);
  assert.equal(outcome.written, false);
  assert.match(outcome.reason, /session closed/u);
  assert.equal(outcome.state, undefined);
});

test('an invalid state is refused rather than written', () => {
  const written = [];
  const session = { append: (type, data) => written.push({ type, data }) };
  const outcome = publishHoldState(session, { engaged: true }, undefined);
  assert.equal(outcome.written, false);
  assert.equal(outcome.reason, 'invalid');
  assert.equal(written.length, 0);
});

process.stdout.write('\nstate construction\n');

test('a hold state reports being engaged with its reason and release edge', () => {
  assert.equal(HOLD.engaged, true);
  assert.equal(HOLD.phase, 'peak');
  assert.equal(HOLD.heldCount, 2);
  assert.equal(HOLD.reason, 'peak');
  assert.equal(HOLD.releaseAtMs, Date.parse('2026-09-15T04:01:00Z'));
  assert.equal(HOLD.overrideActive, false);
  assert.equal(HOLD.overrideUntilMs, null);
});

test('a hold state carries a live override through to the client', () => {
  const state = holdStateFor({
    phase: 'peak',
    heldCount: 1,
    reason: 'peak',
    releaseAtMs: NOW,
    override: { untilMs: NOW + 60_000 },
    nowMs: NOW,
  });
  assert.equal(state.overrideActive, true);
  assert.equal(state.overrideUntilMs, NOW + 60_000);
});

test('a release state clears the hold and records why it was released', () => {
  const released = releaseStateFor({ phase: 'open', releaseReason: 'schedule', nowMs: NOW });
  assert.equal(released.engaged, false);
  assert.equal(released.heldCount, 0);
  assert.equal(released.reason, null);
  assert.equal(released.releaseAtMs, null);
  assert.equal(released.lastReleaseReason, 'schedule');
});

test('a release caused by an override says so, and keeps the override live', () => {
  const released = releaseStateFor({
    phase: 'peak',
    releaseReason: 'override',
    override: { untilMs: NOW + 120_000 },
    nowMs: NOW,
  });
  assert.equal(released.lastReleaseReason, 'override');
  assert.equal(released.overrideActive, true);
  assert.equal(released.overrideUntilMs, NOW + 120_000);
});

test('an unknown phase or reason is not publishable', () => {
  const written = [];
  const session = { append: (type, data) => written.push({ type, data }) };
  assert.equal(publishHoldState(session, { ...HOLD, phase: 'twilight' }, undefined).written, false);
  assert.equal(publishHoldState(session, { ...HOLD, reason: 'vibes' }, undefined).written, false);
  assert.equal(publishHoldState(session, { ...HOLD, lastReleaseReason: 'guesswork' }, undefined).written, false);
  assert.equal(written.length, 0);
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
