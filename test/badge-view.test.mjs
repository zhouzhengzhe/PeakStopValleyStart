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
  BADGE_ACCENTS,
  BADGE_STATES,
  RELEASED_LINGER_MS,
  accentFor,
  badgeStateFor,
  bubbleOpensLeft,
  clampPosition,
  defaultPosition,
  formatClock,
  formatStamp,
  panelFor,
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

test('a live override is shown, because it is the one thing spending money at peak', () => {
  // `panelFor` describes an override, so a visibility rule that suppressed it while
  // idle would leave the badge silent about the most expensive state it knows — the
  // two functions have to agree.
  const overridden = state({ overrideActive: true, overrideUntilMs: NOW });
  assert.equal(shouldShowBubble(overridden), true);
  assert.notEqual(panelFor(overridden, NOW), undefined);
});

process.stdout.write('\nthe panel\n');

test('the panel answers the six questions it is designed to answer', () => {
  const panel = panelFor(
    state({ phase: 'peak', engaged: true, heldCount: 2, reason: 'peak', releaseAtMs: NOW, nextTransitionMs: NOW, nextTransitionEdge: 'release' }),
    NOW,
  );
  assert.equal(panel.rows.length, 6);
  assert.deepEqual(
    panel.rows.map((row) => row.label),
    ['当前档位', '调度决策', '下次切换', '放行时刻', '滞留消息', '手动覆盖'],
  );
});

test('the tariff row leads and carries the mark', () => {
  // The tariff is the fact everything else follows from, so it is the one row the eye
  // is given a mark for — and the mark is the *phase* colour, not the bead's. The
  // design draws off-peak green here, because cheap is the good state, where the bead
  // is grey because the badge itself is doing nothing. Two axes, two colours.
  const panel = panelFor(state({ phase: 'armed' }), NOW);
  assert.match(panel.rows[0].value, /峰前/u);
  assert.match(panel.rows[0].value, /pre-peak/u, 'both languages, because "peak" is the pricing page word');
  assert.equal(panel.rows[0].dotColour, '#ff9500');
  assert.equal(panel.rows.filter((row) => row.dotColour !== null).length, 1, 'exactly one row may carry the mark');

  const offPeak = panelFor(state(), NOW);
  assert.equal(offPeak.rows[0].dotColour, '#34c759', 'off-peak is the cheap good state, so it is marked green');
});

test('the decision row reads as a decision, not as a boolean', () => {
  const held = panelFor(state({ engaged: true, heldCount: 1, reason: 'peak' }), NOW);
  assert.match(held.rows[1].value, /拦截/u);
  assert.match(held.rows[1].value, /峰时计费/u);

  const open = panelFor(state(), NOW);
  assert.match(open.rows[1].value, /放行/u);
  assert.equal(open.rows[1].tone, 'normal', 'an open gate is not an accent worth drawing');
});

test('an override is the only row that gets the alarming tone', () => {
  const panel = panelFor(state({ overrideActive: true, overrideUntilMs: NOW }), NOW);
  const override = panel.rows.find((row) => row.label === '手动覆盖');
  assert.equal(override.tone, 'danger');
  assert.match(override.value, /2026|20\d\d/u, 'and it says until when');
  const quiet = panelFor(state(), NOW).rows.find((row) => row.label === '手动覆盖');
  assert.equal(quiet.tone, 'muted');
  assert.equal(quiet.value, '无');
});

test('a missing instant degrades to words rather than to a broken date', () => {
  // The host always sends these while they apply, so this is the defensive path: a
  // panel must never render "NaN" or "undefined" where a time belongs.
  const panel = panelFor(state({ engaged: true, heldCount: 1, releaseAtMs: null, nextTransitionMs: null }), NOW);
  const values = panel.rows.map((row) => row.value).join(' ');
  assert.ok(!values.includes('NaN'), 'a stamp must never render as NaN');
  assert.ok(!values.includes('undefined'), 'nor as undefined');
  assert.ok(panel.rows.some((row) => row.value === '无'), 'an absent value says so');
});

test('the next switch names the edge it is heading for', () => {
  const panel = panelFor(state({ nextTransitionMs: NOW, nextTransitionEdge: 'arm' }), NOW);
  assert.match(panel.rows[2].value, /峰前/u);
  assert.match(panel.rows[2].value, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u, 'a stamp an operator can compare against a clock');
});

test('an ordinary idle state still produces a panel', () => {
  // "Nothing is wrong" is worth being able to read. The caller decides whether to
  // show it; this function's job is to describe, not to judge.
  const panel = panelFor(state(), NOW);
  assert.notEqual(panel, undefined);
  assert.equal(panelFor(undefined, NOW), undefined, 'but there is nothing to say about no state at all');
});

test('stamps are local wall time and survive a non-finite instant', () => {
  assert.match(formatStamp(NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
  assert.equal(formatStamp(Number.NaN), '');
  assert.equal(formatStamp(undefined), '');
});

process.stdout.write('\nthe status bead\n');

test('each state gets its own bead, and the costly one glows hardest', () => {
  // The design's whole idea: the colour says which state, the halo's radius says how
  // much it matters.
  const idle = accentFor(state(), NOW);
  const armed = accentFor(state({ phase: 'armed' }), NOW);
  const held = accentFor(state({ engaged: true, heldCount: 1 }), NOW);
  const override = accentFor(state({ overrideActive: true }), NOW);

  for (const bead of [idle, armed, held, override]) {
    assert.match(bead.shell, /^#[0-9a-f]{6}$/u, 'a bead colour must be a concrete colour');
    assert.ok(bead.glow > 0);
  }
  assert.equal(new Set([idle.shell, armed.shell, held.shell, override.shell]).size, 4, 'four states, four colours');
  assert.ok(override.glow > held.glow, 'the one state that spends money is the one that shouts');
  assert.ok(idle.glow < armed.glow, 'and the quiet state stays quiet');
  assert.equal(BADGE_ACCENTS.override.shell, '#ff3b30');
});

test('a fresh release borrows the delivered bead and then gives it back', () => {
  const released = state({ lastReleaseAtMs: NOW, lastReleaseReason: 'schedule' });
  assert.equal(accentFor(released, NOW).shell, BADGE_ACCENTS.released.shell);
  assert.equal(accentFor(released, NOW + RELEASED_LINGER_MS + 1).shell, BADGE_ACCENTS.idle.shell);
});

test('an override outranks every other bead', () => {
  // Even while work is held, a live override is what the operator needs to see: it
  // is the only state that is deliberately spending money.
  const both = state({ engaged: true, heldCount: 3, overrideActive: true, overrideUntilMs: NOW });
  assert.equal(accentFor(both, NOW).shell, BADGE_ACCENTS.override.shell);
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
