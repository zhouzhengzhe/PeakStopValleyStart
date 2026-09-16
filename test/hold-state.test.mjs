/**
 * Self-check for the brake's published state: its shape, the live overlay, and
 * the advance-suppression rule.
 *
 * Run with `node test/hold-state.test.mjs`.
 *
 * The state is never written to the session log — a session event of this
 * plugin's own type makes the whole session unloadable, because the harness
 * resolves stored logs against a vocabulary generated from its own repository.
 * The first case below is the regression guard for exactly that, so the defect
 * cannot come back in a different shape.
 *
 * @module peak-valley-brake/test/hold-state
 */

import assert from 'node:assert/strict';

import {
  EMPTY_HOLD_STATE,
  composeLiveState,
  holdStateDiffers,
  holdStateFor,
  holdStateSchema,
  nextPublishedState,
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

process.stdout.write('the session log stays untouched\n');

test('advancing the state never writes a session event', () => {
  // The regression guard. This state used to be published as a
  // `peak-valley-brake/change` session event; the harness refuses to load any
  // stored log containing an event type outside its build-time vocabulary, and a
  // plugin cannot mark its own type ignorable, so two such records made a
  // 9244-record session permanently unreadable. The projection that folded them
  // had no consumer either. Nothing here may reach a session, ever.
  const touched = [];
  const session = {
    id: 'session-regression',
    append: (...args) => touched.push(args),
    appendEvent: (...args) => touched.push(args),
    log: { push: (...args) => touched.push(args) },
  };

  const outcome = nextPublishedState(HOLD, undefined);
  assert.equal(outcome.written, true, 'the state still advances for the badge');
  assert.equal(touched.length, 0, 'and the session is never touched');

  // The writer no longer takes a session at all, so there is no parameter
  // through which a caller could hand it one by accident.
  assert.equal(nextPublishedState.length, 2, 'the signature is (next, previous)');
  assert.deepEqual(touched, []);
});

test('the module exports no session event vocabulary at all', async () => {
  // Absence, not documentation: a future edit cannot reintroduce the write by
  // importing an event type that no longer exists.
  const module = await import('../lib/hold-state.js');
  assert.equal(module.HOLD_EVENT_TYPE, undefined, 'there is no event type to append');
  assert.equal(module.HOLD_PROJECTION_KEY, undefined, 'and no projection key to register');
  assert.equal(module.holdProjectionDefinition, undefined, 'and no projection to publish into');
  assert.equal(module.publishHoldState, undefined, 'and no writer that takes a session');
});

process.stdout.write('\nthe state shape\n');

test('the empty state says nothing is held', () => {
  assert.equal(EMPTY_HOLD_STATE.engaged, false);
  assert.equal(EMPTY_HOLD_STATE.heldCount, 0);
  assert.equal(EMPTY_HOLD_STATE.reason, null);
  assert.equal(EMPTY_HOLD_STATE.overrideActive, false);
});

test('the empty state decodes through the schema the client uses', () => {
  assert.equal(holdStateSchema.safeParse(EMPTY_HOLD_STATE).success, true);
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

test('an unchanged first state is announced once and then stays silent', () => {
  const first = nextPublishedState(HOLD, undefined);
  assert.equal(first.written, true, 'a state nobody has seen is worth announcing');
  assert.deepEqual(first.state, HOLD);

  const second = nextPublishedState({ ...HOLD, updatedAtMs: NOW + 60_000 }, first.state);
  assert.equal(second.written, false, 'a timestamp-only change must not be re-announced');
  assert.equal(second.reason, 'unchanged');
});

test('an invalid state is refused rather than replacing a good one', () => {
  // A malformed state must leave the badge merely stale, never wrong.
  const outcome = nextPublishedState({ engaged: true }, HOLD);
  assert.equal(outcome.written, false);
  assert.equal(outcome.reason, 'invalid');
  assert.equal(outcome.state, HOLD, 'the last good state survives');
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
  assert.equal(nextPublishedState({ ...HOLD, phase: 'twilight' }, undefined).written, false);
  assert.equal(nextPublishedState({ ...HOLD, reason: 'vibes' }, undefined).written, false);
  assert.equal(nextPublishedState({ ...HOLD, lastReleaseReason: 'guesswork' }, undefined).written, false);
});

process.stdout.write('\nthe state handed to a client right now\n');

test('a session that has never published still gets a complete state', () => {
  // The reported bug: the status panel is drawn from this state, and it was composed from
  // the published record alone — which is empty until the brake has actually announced
  // something, i.e. until a message has been held. So the panel came up blank for an
  // ordinary off-peak session, which looks exactly like a broken button.
  const live = composeLiveState(undefined, {
    hold: false,
    reason: 'open',
    phase: 'open',
    releaseAtMs: null,
    heldCount: 0,
    override: undefined,
    nextTransitionMs: 1_700_000_000_000,
    nextTransitionEdge: 'arm',
    nowMs: 1_699_000_000_000,
  });
  assert.equal(live.engaged, false);
  assert.equal(live.phase, 'open');
  assert.equal(live.nextTransitionEdge, 'arm', 'the schedule is answerable without a single publish');
  const decoded = holdStateSchemaShape(live);
  assert.deepEqual(decoded, [], 'and every field must satisfy the schema a client decodes against');
});

test('the held facts come from the live verdict, not from the last announcement', () => {
  const stale = holdStateFor({ phase: 'open', heldCount: 0, reason: 'peak', releaseAtMs: null, nowMs: 1 });
  const live = composeLiveState(stale, {
    hold: true,
    reason: 'peak',
    phase: 'peak',
    releaseAtMs: 1_700_000_000_000,
    heldCount: 3,
    override: undefined,
    nextTransitionMs: null,
    nextTransitionEdge: null,
    nowMs: 1_699_000_000_000,
  });
  assert.equal(live.engaged, true);
  assert.equal(live.phase, 'peak');
  assert.equal(live.reason, 'peak');
  assert.equal(live.heldCount, 3);
  assert.equal(live.releaseAtMs, 1_700_000_000_000);
});

test('an open gate clears everything that only means something while held', () => {
  // Otherwise a stale count or release instant would linger in the panel after a release,
  // saying work is still withheld when it is not.
  const held = holdStateFor({ phase: 'peak', heldCount: 4, reason: 'peak', releaseAtMs: 1_700_000_000_000, nowMs: 1 });
  const live = composeLiveState(held, {
    hold: false,
    reason: 'open',
    phase: 'open',
    releaseAtMs: 1_700_000_000_000,
    heldCount: 4,
    override: undefined,
    nextTransitionMs: null,
    nextTransitionEdge: null,
    nowMs: 2,
  });
  assert.equal(live.engaged, false);
  assert.equal(live.heldCount, 0);
  assert.equal(live.reason, null);
  assert.equal(live.releaseAtMs, null);
});

test('the historical fields survive the overlay', () => {
  // When the last release happened and why are the only facts the published record owns;
  // the live overlay must not wipe them, or the delivered pose never shows.
  const released = releaseStateFor({ phase: 'open', releaseReason: 'schedule', nowMs: 500 });
  const live = composeLiveState(released, {
    hold: false,
    reason: 'open',
    phase: 'open',
    releaseAtMs: null,
    heldCount: 0,
    override: undefined,
    nextTransitionMs: null,
    nextTransitionEdge: null,
    nowMs: 900,
  });
  assert.equal(live.lastReleaseReason, 'schedule');
  assert.equal(live.lastReleaseAtMs, 500);
  assert.equal(live.updatedAtMs, 900, 'and the clock moves');
});

test('a live override is reflected even when nothing is held', () => {
  const live = composeLiveState(undefined, {
    hold: false,
    reason: 'manual-override',
    phase: 'peak',
    releaseAtMs: null,
    heldCount: 0,
    override: { kind: 'window', untilMs: 1_700_000_000_000 },
    nextTransitionMs: null,
    nextTransitionEdge: null,
    nowMs: 1_699_000_000_000,
  });
  assert.equal(live.overrideActive, true);
  assert.equal(live.overrideUntilMs, 1_700_000_000_000);
  assert.equal(live.phase, 'peak', 'the tariff is still peak; only the dispatch is overridden');
});

/**
 * Decode the composed state through the real schema.
 *
 * A shape check rather than a field check: the client decodes this, and a field the
 * schema rejects would leave the panel showing the previous state forever.
 *
 * @param {object} state - the composed state.
 * @returns {string[]} the schema issues, empty when it decodes.
 */
function holdStateSchemaShape(state) {
  const decoded = holdStateSchema.safeParse(state);
  return decoded.success ? [] : decoded.error.issues.map((issue) => issue.path.join('.'));
}

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
