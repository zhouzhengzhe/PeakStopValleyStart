/**
 * Self-check for the info bar's data model.
 *
 * Run with `node test/info-bar-view.test.mjs`. Pure functions, fixed clock, no network.
 *
 * The case worth reading first is "the bar shows the billed tier, not the brake's state".
 * During the pre-peak brace the brake has already stopped dispatching, but a call placed
 * in that minute is still billed off-peak. A bar that borrowed the brake's state would
 * announce "高峰价" early, and the operator would be looking at a price that is not in
 * force — on the one display whose whole purpose is to say what is in force.
 *
 * @module peak-valley-brake/test/info-bar-view
 */

import assert from 'node:assert/strict';

import {
  balanceSegment,
  buildInfoBar,
  currencySymbol,
  formatCountdown,
  spendDetailRows,
  splitSegment,
} from '../lib/info-bar-view.js';
import { nextTierBoundaryAfter, phaseAt } from '../lib/time-window.js';
import { createBalanceState, balanceAfterFailure, balanceAfterSuccess } from '../lib/usage-collect.js';
import { createLedgerState, makeRecord, reduceRecord, spendWindows } from '../lib/usage-ledger.js';

/** Counters for the hand-rolled runner. */
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

/**
 * Build an epoch-ms instant from a UTC calendar description.
 * @param {string} iso - an ISO-8601 UTC timestamp.
 * @returns {number} epoch milliseconds.
 */
function at(iso) {
  const value = Date.parse(iso);
  assert.ok(Number.isFinite(value), `fixture timestamp must parse: ${iso}`);
  return value;
}

/**
 * Assemble a bar input from a few calls.
 * @param {object} options - the fixture.
 * @returns {object} the result of `buildInfoBar`.
 */
function barAt(iso, options = {}) {
  const nowMs = at(iso);
  const state = createLedgerState();
  for (const call of options.calls ?? []) {
    reduceRecord(
      state,
      makeRecord({
        atMs: at(call.at),
        model: call.model ?? 'deepseek-flash',
        sessionId: call.sessionId ?? 's1',
        tokens: { cacheMiss: 1_000_000, cacheHit: 1_000_000, cacheWrite: 0, output: 1_000_000 },
      }),
    );
  }
  return buildInfoBar({
    nowMs,
    model: options.model ?? 'deepseek-flash',
    providerName: options.providerName,
    balance: options.balance ?? balanceAfterSuccess(createBalanceState(), { currency: 'CNY', total: 515 }, nowMs),
    windows: spendWindows(state, { nowMs, sessionId: options.sessionId ?? 's1' }),
    unpricedModels: options.unpricedModels,
  });
}

/**
 * Find one segment by id.
 * @param {object} view - the bar view model.
 * @param {string} id - the segment id.
 * @returns {object} the segment.
 */
function segment(view, id) {
  const found = view.segments.find((entry) => entry.id === id);
  assert.ok(found !== undefined, `segment ${id} must exist`);
  return found;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('the countdown is mm:ss under an hour and gains hours beyond it', () => {
  assert.equal(formatCountdown(38 * 60_000 + 36_000), '38:36');
  assert.equal(formatCountdown(59_000), '00:59');
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(-5_000), '00:00', 'a lapsed countdown reads zero rather than going negative');
  assert.equal(formatCountdown(3_600_000), '1:00:00');
  assert.equal(formatCountdown(3_723_000), '1:02:03');
  assert.equal(formatCountdown(Number.POSITIVE_INFINITY), '—', 'no next edge is not the same as now');
});

test('currency symbols are resolved, and an unknown code is left legible', () => {
  assert.equal(currencySymbol('CNY'), '¥');
  assert.equal(currencySymbol('USD'), '$');
  assert.equal(currencySymbol('EUR'), 'EUR ');
});

// ---------------------------------------------------------------------------
// The tariff arithmetic behind the countdown
// ---------------------------------------------------------------------------

test('off-peak counts down to the next peak, and peak counts down to the next off-peak', () => {
  // Wednesday. Off-peak at 00:30Z; the peak window opens at 01:00Z.
  assert.equal(nextTierBoundaryAfter(at('2026-09-16T00:30:00Z')), at('2026-09-16T01:00:00Z'));
  // Peak at 02:00Z; that window closes at 04:00Z.
  assert.equal(nextTierBoundaryAfter(at('2026-09-16T02:00:00Z')), at('2026-09-16T04:00:00Z'));
  // Off-peak in the midday gap; the second window opens at 06:00Z.
  assert.equal(nextTierBoundaryAfter(at('2026-09-16T05:00:00Z')), at('2026-09-16T06:00:00Z'));
  // Off-peak after the last window on a Friday: the next peak is Monday 01:00Z.
  assert.equal(nextTierBoundaryAfter(at('2026-09-18T11:00:00Z')), at('2026-09-21T01:00:00Z'));
});

test('the countdown matches the tariff at the boundary instants', () => {
  assert.equal(formatCountdown(nextTierBoundaryAfter(at('2026-09-16T00:56:00Z')) - at('2026-09-16T00:56:00Z')), '04:00');
  assert.equal(formatCountdown(nextTierBoundaryAfter(at('2026-09-16T03:30:00Z')) - at('2026-09-16T03:30:00Z')), '30:00');
});

// ---------------------------------------------------------------------------
// The rule this module exists to enforce
// ---------------------------------------------------------------------------

test('the bar shows the billed tier, not the brake state', () => {
  // Beijing 08:56 is inside the brake's five-minute pre-peak brace: dispatching has
  // already stopped, but the price has not changed yet.
  const nowMs = at('2026-09-16T00:56:00Z');
  assert.equal(phaseAt(nowMs).state, 'armed', 'fixture: the brake really is holding here');
  const view = barAt('2026-09-16T00:56:00Z');
  const tier = segment(view, 'tier');
  assert.equal(tier.text, '空闲价', 'the price in force is still the off-peak one');
  assert.equal(tier.tone, 'off-peak');
  assert.equal(segment(view, 'countdown').text, '距高峰 04:00', 'and the peak is four minutes away');
});

test('the tier flips exactly at the tariff edge, not at the brace', () => {
  assert.equal(segment(barAt('2026-09-16T00:59:59Z'), 'tier').text, '空闲价');
  assert.equal(segment(barAt('2026-09-16T01:00:00Z'), 'tier').text, '高峰价');
  assert.equal(segment(barAt('2026-09-16T04:00:00Z'), 'tier').text, '空闲价');
});

test('a weekend always reads off-peak, with the next peak on Monday', () => {
  const view = barAt('2026-09-19T02:00:00Z'); // Saturday, inside a weekday's peak window
  assert.equal(segment(view, 'tier').text, '空闲价');
  assert.equal(segment(view, 'countdown').text, '距高峰 47:00:00', 'from Saturday 02:00Z to Monday 01:00Z');
});

// ---------------------------------------------------------------------------
// Balance: three distinct situations
// ---------------------------------------------------------------------------

test('a fresh balance reads as a plain figure', () => {
  const state = balanceAfterSuccess(createBalanceState(), { currency: 'CNY', total: 515.75 }, at('2026-09-16T02:00:00Z'));
  const rendered = balanceSegment(state, at('2026-09-16T02:00:10Z'));
  assert.equal(rendered.text, '余额 ¥515.750');
  assert.equal(rendered.tone, 'plain');
  assert.match(rendered.title, /10 秒前/u);
});

test('a stale balance keeps its figure and says so', () => {
  let state = balanceAfterSuccess(createBalanceState(), { currency: 'CNY', total: 515 }, at('2026-09-16T02:00:00Z'));
  state = balanceAfterFailure(state, { kind: 'network', message: 'socket closed' }, at('2026-09-16T02:05:00Z'));
  const rendered = balanceSegment(state, at('2026-09-16T02:05:00Z'));
  assert.equal(rendered.text, '余额 ¥515.000', 'the last known figure is still shown');
  assert.equal(rendered.tone, 'warn');
  assert.match(rendered.title, /network/u, 'and the reason is available');
  assert.match(rendered.title, /300 秒前/u, 'along with how old the figure is');
});

test('a balance that never arrived says so instead of showing zero', () => {
  const never = balanceSegment(createBalanceState(), at('2026-09-16T02:00:00Z'));
  assert.equal(never.text, '余额 —');
  assert.equal(never.tone, 'muted');

  const failed = balanceAfterFailure(createBalanceState(), { kind: 'no-credential', message: 'no credential configured' }, at('2026-09-16T02:00:00Z'));
  const rendered = balanceSegment(failed, at('2026-09-16T02:00:00Z'));
  assert.equal(rendered.text, '余额 暂不可用');
  assert.equal(rendered.tone, 'warn');
  assert.match(rendered.title, /no-credential/u);
  assert.equal(rendered.text.includes('0.000'), false, 'an unreadable balance is not an empty one');
});

// ---------------------------------------------------------------------------
// Spend, and the split that is this feature's point
// ---------------------------------------------------------------------------

test('the split sums to the session total it sits beside', () => {
  const view = barAt('2026-09-16T09:00:00Z', {
    calls: [
      { at: '2026-09-16T02:00:00Z' }, // peak, ¥10.04
      { at: '2026-09-16T05:00:00Z' }, // off-peak, ¥5.02
    ],
  });
  assert.equal(segment(view, 'session').text, '本会话 ¥15.060');
  assert.equal(segment(view, 'split').text, '高峰 ¥10.040 · 空闲 ¥5.020');
  const slide = view.spend.session;
  assert.equal(slide.totalCny, slide.peakCny + slide.offPeakCny, 'the invariant the display depends on');
  assert.equal(slide.peakCny, 10.04);
  assert.equal(slide.offPeakCny, 5.02);
});

test('an empty session reads as zero rather than as an error', () => {
  const view = barAt('2026-09-16T09:00:00Z');
  assert.equal(segment(view, 'session').text, '本会话 ¥0.000');
  assert.equal(segment(view, 'split').text, '高峰 ¥0.000 · 空闲 ¥0.000');
  assert.deepEqual(view.warnings, []);
});

test('the anchor names the provider and the model', () => {
  const view = barAt('2026-09-16T02:00:00Z', { providerName: 'DeepSeek', model: 'deepseek-flash' });
  assert.equal(segment(view, 'anchor').text, 'DeepSeek · deepseek-flash');
  const fallback = barAt('2026-09-16T02:00:00Z', { model: '' });
  assert.equal(segment(fallback, 'anchor').text, 'DeepSeek · 未选择模型');
});

test('the hover detail offers all four windows, each split', () => {
  const view = barAt('2026-09-16T09:00:00Z', { calls: [{ at: '2026-09-16T02:00:00Z' }] });
  const rows = spendDetailRows(view);
  assert.deepEqual(rows.map((row) => row.label), ['本会话', '今日', '近一月', '全部']);
  for (const row of rows) {
    assert.match(row.total, /^¥\d+\.\d{3}$/u, row.label);
    assert.match(row.split, /^高峰 ¥[\d.]+ · 空闲 ¥[\d.]+$/u, row.label);
  }
  assert.equal(rows[1].total, '¥10.040', 'today holds the one peak call');
});

test('unpriced work is visible rather than silently absent', () => {
  const view = barAt('2026-09-16T09:00:00Z', {
    calls: [{ at: '2026-09-16T02:00:00Z', model: 'brand-new-model' }],
    model: 'brand-new-model',
    unpricedModels: ['brand-new-model'],
  });
  assert.equal(view.spend.session.unpricedCalls, 1);
  assert.equal(view.spend.session.totalCny, 0, 'an unpriceable call contributes no money');
  assert.ok(view.warnings.some((entry) => entry.includes('未定价')), 'but it is announced');
  assert.match(segment(view, 'session').title, /未定价/u);
});

test('a failing balance appears in the warnings list', () => {
  const failed = balanceAfterFailure(createBalanceState(), { kind: 'timeout', message: 'slow' }, at('2026-09-16T02:00:00Z'));
  const view = barAt('2026-09-16T02:00:00Z', { balance: failed });
  assert.ok(view.warnings.some((entry) => entry.includes('timeout')));
});

test('every segment carries an id, text, tone and a title', () => {
  const view = barAt('2026-09-16T02:00:00Z');
  const ids = view.segments.map((entry) => entry.id);
  assert.deepEqual(ids, ['anchor', 'balance', 'tier', 'countdown', 'session', 'split']);
  for (const entry of view.segments) {
    assert.equal(typeof entry.text, 'string', entry.id);
    assert.equal(typeof entry.title, 'string', entry.id);
    assert.ok(entry.text.length > 0, `${entry.id} must have text`);
    assert.ok(
      ['plain', 'peak', 'off-peak', 'muted', 'warn'].includes(entry.tone),
      `${entry.id} has an unknown tone: ${entry.tone}`,
    );
  }
  assert.equal(new Set(ids).size, ids.length, 'segment ids must be unique');
});

test('splitSegment states both halves even when one of them is zero', () => {
  const only = splitSegment({
    peakCny: 0,
    offPeakCny: 5.02,
    totalCny: 5.02,
    calls: 1,
    unpricedCalls: 0,
    currency: 'CNY',
  });
  assert.equal(only.text, '高峰 ¥0.000 · 空闲 ¥5.020');
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
