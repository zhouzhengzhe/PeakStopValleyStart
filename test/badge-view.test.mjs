/**
 * Self-check for the badge's presentation logic.
 *
 * Run with `node test/badge-view.test.mjs`.
 *
 * Everything here is upstream of the DOM precisely because the DOM cannot be
 * tested here: there is no browser in this suite. Which character shows, when the
 * bubble appears, where the badge may sit, and which buttons are live are all
 * decisions that can be wrong in ways a screenshot would reveal only by luck, so
 * they are asserted instead.
 *
 * @module peak-valley-brake/test/badge-view
 */

import assert from 'node:assert/strict';

import {
  BADGE_STATES,
  RELEASED_LINGER_MS,
  badgeStateFor,
  bubbleContentFor,
  bubbleOpensLeft,
  clampPosition,
  defaultPosition,
  formatClock,
  shouldShowBubble,
  toolbarFor,
} from '../lib/badge-view.js';

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

/** A fixed instant, so nothing depends on when the suite runs. */
const NOW = Date.parse('2026-09-15T06:00:00Z');

/**
 * Build a published state with sensible defaults.
 * @param {object} [overrides] - fields to override.
 * @returns {object} the state.
 */
function state(overrides = {}) {
  return {
    engaged: false,
    phase: 'open',
    heldCount: 0,
    reason: null,
    releaseAtMs: null,
    lastReleaseReason: null,
    lastReleaseAtMs: null,
    overrideActive: false,
    overrideUntilMs: null,
    updatedAtMs: NOW,
    ...overrides,
  };
}

process.stdout.write('peak-valley-brake badge view\n\n');

process.stdout.write('which character shows\n');

test('every state resolves to art that exists', () => {
  const cases = [
    state(),
    state({ phase: 'armed' }),
    state({ engaged: true, phase: 'peak', heldCount: 2 }),
    state({ lastReleaseAtMs: NOW - 1000 }),
  ];
  for (const candidate of cases) {
    assert.ok(BADGE_STATES.includes(badgeStateFor(candidate, NOW)));
  }
});

test('an absent state falls back to idle rather than throwing', () => {
  assert.equal(badgeStateFor(undefined, NOW), 'idle');
  assert.equal(badgeStateFor(null, NOW), 'idle');
});

test('a hold shows the withholding pose', () => {
  assert.equal(badgeStateFor(state({ engaged: true, phase: 'peak', heldCount: 1 }), NOW), 'held');
});

test('the pre-peak brace shows the warning pose', () => {
  assert.equal(badgeStateFor(state({ phase: 'armed' }), NOW), 'armed');
});

test('a fresh release shows the delivery pose', () => {
  const released = state({ engaged: false, lastReleaseAtMs: NOW - 500 });
  assert.equal(badgeStateFor(released, NOW), 'released');
});

test('the delivery pose expires on the badge\'s own clock', () => {
  const released = state({ lastReleaseAtMs: NOW - RELEASED_LINGER_MS - 1 });
  assert.equal(badgeStateFor(released, NOW), 'idle');
});

test('work held again inside the linger window still shows as held', () => {
  // `engaged` is authoritative for the present moment; `lastReleaseAtMs` only
  // records the past. Letting a recent release win here would make the badge
  // claim delivery while it is in fact withholding.
  const both = state({ engaged: true, phase: 'peak', heldCount: 1, lastReleaseAtMs: NOW - 100 });
  assert.equal(badgeStateFor(both, NOW), 'held');
});

process.stdout.write('\nthe bubble\n');

test('the bubble appears when work is held', () => {
  assert.equal(shouldShowBubble(state({ engaged: true, phase: 'peak', heldCount: 1 })), true);
});

test('the bubble warns during the pre-peak brace', () => {
  assert.equal(shouldShowBubble(state({ phase: 'armed' })), true);
});

test('the bubble stays away when nothing is happening', () => {
  assert.equal(shouldShowBubble(state()), false);
  assert.equal(shouldShowBubble(undefined), false);
});

test('a dismissed bubble stays dismissed', () => {
  assert.equal(shouldShowBubble(state({ engaged: true, heldCount: 3 }), { hidden: true }), false);
});

test('a pinned bubble shows even when idle', () => {
  assert.equal(shouldShowBubble(state(), { forceShow: true }), true);
});

test('the held bubble reports the count and the release time', () => {
  const content = bubbleContentFor(state({ engaged: true, heldCount: 2, releaseAtMs: NOW }), NOW, {
    held: '已拦截',
    count: '条',
    autoRelease: '自动放行',
  });
  assert.match(content.title, /已拦截 2 条/u);
  assert.match(content.detail, /自动放行/u);
});

test('the armed bubble says the peak is coming', () => {
  const content = bubbleContentFor(state({ phase: 'armed', releaseAtMs: NOW }), NOW, { armed: '即将进入峰时' });
  assert.match(content.title, /即将进入峰时/u);
});

test('a live override is surfaced even when nothing is held', () => {
  const content = bubbleContentFor(state({ overrideActive: true, overrideUntilMs: NOW }), NOW, {
    override: '已按峰价放行',
  });
  assert.ok(content !== undefined, 'an override spends money and must be visible');
  assert.match(content.title, /已按峰价放行/u);
});

test('an ordinary idle state has nothing to say', () => {
  assert.equal(bubbleContentFor(state(), NOW), undefined);
  assert.equal(bubbleContentFor(undefined, NOW), undefined);
});

test('a missing release instant still says it will be released, without a clock', () => {
  // The published state always carries a release edge while held, so this is the
  // defensive path: the bubble must degrade to the words rather than render an
  // empty or non-finite time.
  const content = bubbleContentFor(state({ engaged: true, heldCount: 1, releaseAtMs: null }), NOW, {
    autoRelease: '自动放行',
  });
  assert.equal(content.detail, '自动放行');
  assert.ok(!content.detail.includes('NaN'), 'a clock must never render as NaN');
});

process.stdout.write('\npositioning\n');

test('a default position keeps the badge inside the viewport', () => {
  const position = defaultPosition({ width: 96, height: 120 }, { width: 1200, height: 800 });
  assert.ok(position.x + 96 <= 1200);
  assert.ok(position.y + 120 <= 800);
});

test('clamping keeps the whole badge on screen', () => {
  const clamped = clampPosition({ x: -50, y: 5000 }, { width: 96, height: 120 }, { width: 1200, height: 800 });
  assert.ok(clamped.x >= 0);
  assert.ok(clamped.y + 120 <= 800, 'an off-screen badge cannot be dragged back');
});

test('clamping survives a viewport smaller than the badge', () => {
  // A tiny window must not produce a negative maximum and fling the badge off
  // screen; the margin wins.
  const clamped = clampPosition({ x: 10, y: 10 }, { width: 200, height: 300 }, { width: 100, height: 100 }, 8);
  assert.equal(clamped.x, 8);
  assert.equal(clamped.y, 8);
});

test('the bubble flips to the left when the badge is near the right edge', () => {
  assert.equal(bubbleOpensLeft({ x: 1100, width: 96 }, 280, 1200), true);
  assert.equal(bubbleOpensLeft({ x: 100, width: 96 }, 280, 1200), false);
});

process.stdout.write('\nthe toolbar\n');

test('every button maps to an action the endpoint accepts', () => {
  const actions = toolbarFor(state({ engaged: true, phase: 'peak' })).map((button) => button.action);
  assert.deepEqual(actions, ['status', 'now', 'window', 'cancel']);
});

test('status is always available', () => {
  assert.equal(toolbarFor(state()).find((b) => b.action === 'status').enabled, true);
});

test('releasing once needs something held, and says so when not', () => {
  const idle = toolbarFor(state()).find((b) => b.action === 'now');
  assert.equal(idle.enabled, false);
  assert.ok(idle.hint.length > 0, 'a disabled button must explain itself');

  const held = toolbarFor(state({ engaged: true, phase: 'peak' })).find((b) => b.action === 'now');
  assert.equal(held.enabled, true);
});

test('the continuous release is offered during peak and warns about cost', () => {
  const button = toolbarFor(state({ phase: 'peak' })).find((b) => b.action === 'window');
  assert.equal(button.enabled, true);
  assert.match(button.hint, /峰价/u, 'a control that spends money at peak must say so');
});

test('the continuous release is refused off-peak with a reason', () => {
  const button = toolbarFor(state({ phase: 'open' })).find((b) => b.action === 'window');
  assert.equal(button.enabled, false);
  assert.ok(button.hint.length > 0);
});

test('cancel needs a live override', () => {
  assert.equal(toolbarFor(state({ phase: 'peak' })).find((b) => b.action === 'cancel').enabled, false);
  assert.equal(
    toolbarFor(state({ phase: 'peak', overrideActive: true })).find((b) => b.action === 'cancel').enabled,
    true,
  );
});

test('a live override disables a second continuous release', () => {
  const button = toolbarFor(state({ phase: 'peak', overrideActive: true })).find((b) => b.action === 'window');
  assert.equal(button.enabled, false, 'granting twice is meaningless and would extend billing');
});

process.stdout.write('\nformatting\n');

test('a clock renders as local wall time without seconds', () => {
  assert.match(formatClock(NOW), /^\d{2}:\d{2}$/u);
});

test('a non-finite instant renders as empty rather than "NaN"', () => {
  assert.equal(formatClock(undefined), '');
  assert.equal(formatClock(Number.NaN), '');
  assert.equal(formatClock(null), '');
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
