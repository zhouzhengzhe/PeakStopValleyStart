/**
 * Self-check for the spend ledger and the DeepSeek price table.
 *
 * Run with `node test/usage-ledger.test.mjs`. No runner, no dependencies: both modules
 * under test are pure, so this suite is arithmetic over a fixed clock.
 *
 * **Every expected amount here is an independent literal**, hand-computed from the
 * published prices and written out in full, never recomputed the way the implementation
 * computes it. A test that re-derives its expectation from the same formula can only ever
 * prove the code agrees with itself.
 *
 * Published prices under test (https://api-docs.deepseek.com/zh-cn/quick_start/pricing,
 * CNY per 1M tokens; off-peak is half of peak):
 *
 *   deepseek-flash    cache-hit 0.04 / 0.02   cache-miss 2 / 1   output 8 / 4
 *   deepseek-v4-pro   cache-hit 0.30 / 0.15   cache-miss 9 / 4.5 output 27 / 13.5
 *
 * The suite also pins the tariff zone by forcing the process into a distant time zone:
 * if any boundary were computed from local time instead of the tariff's UTC+8, the day and
 * month assertions below would move.
 *
 * @module peak-valley-brake/test/usage-ledger
 */

// Set before anything reads a clock. Node re-reads TZ on first Date use, and this runs
// first, so the process really is in Los Angeles for the whole suite.
process.env.TZ = 'America/Los_Angeles';

import assert from 'node:assert/strict';

import {
  LEDGER_VERSION,
  TARIFF_UTC_OFFSET_MINUTES,
  createLedgerState,
  dayKey,
  makeRecord,
  monthKey,
  pruneDays,
  reduceRecord,
  sanitizeTokens,
  slideOf,
  spendWindows,
  tierAt,
  unpricedModels,
} from '../lib/usage-ledger.js';
import {
  PRICE_TABLE,
  TARIFF_TIERS,
  costOfUsage,
  formatYuan,
  isPriced,
  ratesFor,
} from '../lib/price-table.js';

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
 * One million of every token class — chosen so each class contributes exactly its own
 * published price to the total, which makes the expected sum readable off the price list.
 * @param {object} [overrides] - counts to replace.
 * @returns {{cacheMiss: number, cacheHit: number, cacheWrite: number, output: number}} the tokens.
 */
function oneMillionEach(overrides = {}) {
  return { cacheMiss: 1_000_000, cacheHit: 1_000_000, cacheWrite: 0, output: 1_000_000, ...overrides };
}

// ---------------------------------------------------------------------------
// Fixture integrity. These run first: if a calendar assumption below is wrong, the
// suite must say so instead of quietly asserting something weaker than it claims.
// ---------------------------------------------------------------------------

test('fixtures: the weekday and zone assumptions this suite rests on are real', () => {
  assert.equal(new Date(at('2026-09-16T04:00:00Z')).getUTCDay(), 3, '2026-09-16 must be a Wednesday');
  assert.equal(new Date(at('2026-09-19T04:00:00Z')).getUTCDay(), 6, '2026-09-19 must be a Saturday');
  assert.equal(new Date(at('2026-09-20T04:00:00Z')).getUTCDay(), 0, '2026-09-20 must be a Sunday');
  assert.equal(TARIFF_UTC_OFFSET_MINUTES, 480, 'the tariff zone is UTC+8');
  // Proves the TZ override took effect, so the zone assertions below are not vacuous.
  if (new Date(at('2026-09-16T04:00:00Z')).getTimezoneOffset() === 0) {
    process.stdout.write('       note: this runtime ignored TZ; the zone cases below are weaker here\n');
  }
});

// ---------------------------------------------------------------------------
// T1 · Price conversion
// ---------------------------------------------------------------------------

test('T1 one million of every class at flash peak costs ¥10.04', () => {
  // 1M×2 (miss) + 1M×0.04 (hit) + 1M×8 (output), over 1M = 2 + 0.04 + 8
  assert.equal(costOfUsage('deepseek-flash', 'peak', oneMillionEach()), 10.04);
});

test('T1 the same call off-peak costs half', () => {
  // 1 + 0.02 + 4
  assert.equal(costOfUsage('deepseek-flash', 'off-peak', oneMillionEach()), 5.02);
});

test('T1 deepseek-v4-pro at peak costs ¥36.30', () => {
  // 9 + 0.3 + 27
  assert.equal(costOfUsage('deepseek-v4-pro', 'peak', oneMillionEach()), 36.3);
});

test('T1 off-peak is exactly half of peak for every priced model', () => {
  for (const model of Object.keys(PRICE_TABLE)) {
    for (const key of ['cacheMiss', 'cacheHit', 'output']) {
      assert.equal(
        ratesFor(model, 'off-peak')[key] * 2,
        ratesFor(model, 'peak')[key],
        `${model}.${key}: off-peak must be half of peak`,
      );
    }
  }
});

test('T1 a cache hit is far cheaper than a cache miss, in that order', () => {
  // Guards the classic transposition: swapping the two rates would still produce a
  // plausible-looking number, just a badly wrong one.
  for (const model of Object.keys(PRICE_TABLE)) {
    for (const tier of TARIFF_TIERS) {
      const row = ratesFor(model, tier);
      assert.ok(row.cacheHit < row.cacheMiss, `${model}/${tier}: a cache hit must be cheaper than a miss`);
      assert.ok(row.cacheHit * 2 <= row.cacheMiss, `${model}/${tier}: hits must be *substantially* cheaper`);
    }
  }
});

test('T1 a cache write is billed at the miss rate', () => {
  // A token being written to the cache is by definition an input token that missed.
  const writeOnly = { cacheMiss: 0, cacheHit: 0, cacheWrite: 1_000_000, output: 0 };
  assert.equal(costOfUsage('deepseek-flash', 'peak', writeOnly), 2);
  assert.equal(costOfUsage('deepseek-v4-pro', 'peak', writeOnly), 9);
});

test('T1 an unpriced model yields no amount at all, while a priced zero-token call yields zero', () => {
  assert.equal(costOfUsage('some-new-model', 'peak', oneMillionEach()), undefined, 'unknown model must not be guessed');
  assert.equal(isPriced('some-new-model'), false);
  const zero = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 };
  assert.equal(costOfUsage('deepseek-flash', 'peak', zero), 0, 'free is a number; unknown is not');
});

test('T1 the retired flash aliases are priced as flash, per the official footnote', () => {
  for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(costOfUsage(alias, 'peak', oneMillionEach()), 10.04, alias);
  }
});

test('T1 a real day from the running ledger reproduces to the fen', () => {
  // Independent cross-check against another implementation's stored figure. This is the
  // 2026-09-14 row of the live ledger, which was entirely off-peak:
  //   input 91289, cacheRead 3188864, output 21659  ->  stored cost 0.241703
  const computed = costOfUsage('deepseek-flash', 'off-peak', {
    cacheMiss: 91289,
    cacheHit: 3_188_864,
    cacheWrite: 0,
    output: 21659,
  });
  assert.ok(Math.abs(computed - 0.24170228) < 1e-12, `expected 0.24170228, received ${computed}`);
});

test('T1 formatYuan keeps three decimals so a sub-fen call is still visible', () => {
  assert.equal(formatYuan(0), '0.000');
  assert.equal(formatYuan(0.0004), '0.000');
  assert.equal(formatYuan(1.5), '1.500');
  assert.equal(formatYuan(Number.NaN), '0.000');
});

// ---------------------------------------------------------------------------
// T2 · Tier assignment — the most error-prone rule, so the heaviest coverage
// ---------------------------------------------------------------------------

test('T2 the peak window edges are half-open, in Beijing time', () => {
  // Beijing 09:00 = UTC 01:00 is the first peak minute; 11:59:59 is the last; 12:00 is out.
  assert.equal(tierAt(at('2026-09-16T00:59:59Z')), 'off-peak', 'Beijing 08:59:59');
  assert.equal(tierAt(at('2026-09-16T01:00:00Z')), 'peak', 'Beijing 09:00:00');
  assert.equal(tierAt(at('2026-09-16T03:59:59Z')), 'peak', 'Beijing 11:59:59');
  assert.equal(tierAt(at('2026-09-16T04:00:00Z')), 'off-peak', 'Beijing 12:00:00');
  assert.equal(tierAt(at('2026-09-16T05:59:59Z')), 'off-peak', 'Beijing 13:59:59');
  assert.equal(tierAt(at('2026-09-16T06:00:00Z')), 'peak', 'Beijing 14:00:00');
  assert.equal(tierAt(at('2026-09-16T09:59:59Z')), 'peak', 'Beijing 17:59:59');
  assert.equal(tierAt(at('2026-09-16T10:00:00Z')), 'off-peak', 'Beijing 18:00:00');
});

test('T2 the whole weekend is off-peak, including the hours that are peak on a weekday', () => {
  // Saturday and Sunday at 01:30 UTC would be peak on a weekday.
  assert.equal(tierAt(at('2026-09-19T01:30:00Z')), 'off-peak', 'Saturday');
  assert.equal(tierAt(at('2026-09-20T01:30:00Z')), 'off-peak', 'Sunday');
  assert.equal(tierAt(at('2026-09-19T07:00:00Z')), 'off-peak', 'Saturday, second window');
  // The same clock time on the adjacent Friday and Monday is peak: the day is what changed.
  assert.equal(tierAt(at('2026-09-18T07:00:00Z')), 'peak', 'Friday');
  assert.equal(tierAt(at('2026-09-21T07:00:00Z')), 'peak', 'Monday');
});

test('T2 a call that straddles the boundary is billed at the tier it started in', () => {
  // Initiated Beijing 08:59:59 (off-peak), completed Beijing 09:01 (peak). The rule is
  // that the *starting* tier governs. Asserting the later instant differs is what makes
  // this a real discriminator: a completion-time implementation fails here.
  const startedAt = at('2026-09-16T00:59:59Z');
  const finishedAt = at('2026-09-16T01:01:00Z');
  assert.equal(tierAt(startedAt), 'off-peak', 'the tier the call was accepted at');
  assert.notEqual(tierAt(finishedAt), tierAt(startedAt), 'the two instants must straddle the edge');
  const record = makeRecord({ atMs: startedAt, model: 'deepseek-flash', tokens: oneMillionEach() });
  assert.equal(record.tier, 'off-peak', 'the record must carry the starting tier');
  assert.equal(record.costCny, 5.02, 'and therefore the off-peak price');
});

test('T2 tier assignment ignores the process time zone', () => {
  // The process is in Los Angeles for this whole suite. If tierAt used local accessors,
  // Beijing 09:00 would land in a different window and this would fail.
  assert.equal(new Date(at('2026-09-16T01:00:00Z')).getHours() !== 9, true, 'local hour must differ from Beijing');
  assert.equal(tierAt(at('2026-09-16T01:00:00Z')), 'peak');
});

test('T2 day and month keys are tariff-zone dates, not UTC dates and not local dates', () => {
  // Both instants below fall on UTC 2026-09-15, but on different Beijing days.
  assert.equal(new Date(at('2026-09-15T15:59:00Z')).getUTCDate(), 15, 'fixture: same UTC date');
  assert.equal(dayKey(at('2026-09-15T15:59:00Z')), '2026-09-15', 'Beijing 23:59');
  assert.equal(dayKey(at('2026-09-15T16:01:00Z')), '2026-09-16', 'Beijing 00:01 next day');

  // Same UTC date again, different Beijing months.
  assert.equal(monthKey(at('2026-09-30T15:00:00Z')), '2026-09', 'Beijing Sep 30');
  assert.equal(monthKey(at('2026-09-30T17:00:00Z')), '2026-10', 'Beijing Oct 1');
});

// ---------------------------------------------------------------------------
// T3 · Aggregation and its invariants
// ---------------------------------------------------------------------------

/**
 * Build a ledger from a list of calls.
 * @param {Array<[string, object?]>} calls - `[iso, overrides]` pairs; overrides may carry `tokens`, `model`, `sessionId`, `status`.
 * @param {object} [defaults] - values used when a call does not override them.
 * @returns {object} the ledger state.
 */
function ledgerOf(calls, defaults = {}) {
  const state = createLedgerState();
  for (const [iso, overrides = {}] of calls) {
    const record = makeRecord({
      atMs: at(iso),
      model: overrides.model ?? defaults.model ?? 'deepseek-flash',
      sessionId: overrides.sessionId ?? defaults.sessionId ?? 'session-a',
      tokens: overrides.tokens ?? oneMillionEach(),
      status: overrides.status,
    });
    reduceRecord(state, record);
  }
  return state;
}

test('T3 a fresh ledger reports zero everywhere and does not throw', () => {
  const windows = spendWindows(createLedgerState(), { nowMs: at('2026-09-16T02:00:00Z'), sessionId: 'session-a' });
  assert.deepEqual(windows.session.totalCny, 0);
  assert.deepEqual(windows.today.totalCny, 0);
  assert.deepEqual(windows.month.totalCny, 0);
  assert.deepEqual(windows.all.totalCny, 0);
  assert.equal(windows.all.calls, 0);
  assert.equal(createLedgerState().version, LEDGER_VERSION);
});

test('T3 peak plus off-peak equals the total in every window', () => {
  // Two peak calls and one off-peak call, in one session, on one day.
  const state = ledgerOf([
    ['2026-09-16T02:00:00Z'],
    ['2026-09-16T03:00:00Z'],
    ['2026-09-16T05:00:00Z'],
  ]);
  const windows = spendWindows(state, { nowMs: at('2026-09-16T07:00:00Z'), sessionId: 'session-a' });
  for (const key of ['session', 'today', 'month', 'all']) {
    const slide = windows[key];
    assert.equal(slide.totalCny, slide.peakCny + slide.offPeakCny, `${key}: the split must sum to the total`);
  }
  assert.equal(formatYuan(windows.session.peakCny), '20.080', 'two peak calls at ¥10.04');
  assert.equal(formatYuan(windows.session.offPeakCny), '5.020', 'one off-peak call at ¥5.02');
  assert.equal(formatYuan(windows.session.totalCny), '25.100', 'peak ¥20.08 + off-peak ¥5.02');
  assert.equal(windows.session.calls, 3);
});

test('T3 float drift stays far below the last displayed digit', () => {
  // Adding three money values in binary floating point does not land exactly on the
  // decimal sum. This is worth stating out loud rather than hiding: the raw total is a
  // few ulps low, and the *displayed* total is exact. Anything that ever compared these
  // figures for equality without rounding would be comparing the wrong things.
  const state = ledgerOf([['2026-09-16T02:00:00Z'], ['2026-09-16T03:00:00Z'], ['2026-09-16T05:00:00Z']]);
  const slide = spendWindows(state, { nowMs: at('2026-09-16T07:00:00Z'), sessionId: 'session-a' }).session;
  assert.notEqual(slide.totalCny, 25.1, 'the raw sum is not exactly the decimal 25.1');
  assert.ok(Math.abs(slide.totalCny - 25.1) < 1e-9, 'but it is nine orders of magnitude inside a fen');
  assert.equal(formatYuan(slide.totalCny), '25.100', 'so the figure an operator reads is exact');
  assert.equal(slide.totalCny, slide.peakCny + slide.offPeakCny, 'and the invariant still holds exactly');
});

test('T3 the calendar windows nest: today is inside this month, which is inside everything', () => {
  const state = ledgerOf([
    ['2026-09-16T02:00:00Z'], // today
    ['2026-09-15T02:00:00Z'], // yesterday, same month
    ['2026-09-02T02:00:00Z'], // earlier this month
    ['2026-08-20T02:00:00Z', { sessionId: 'session-b' }], // last month, another session
  ]);
  const windows = spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-a' });
  assert.equal(windows.all.calls, 4);
  assert.equal(windows.month.calls, 3, 'the August call is outside this month');
  assert.equal(windows.today.calls, 1, 'only the 09-16 call is today');
  assert.equal(windows.session.calls, 3, 'the August call belongs to another session');
  assert.equal(formatYuan(windows.today.totalCny), '10.040', 'one peak call today');
  assert.ok(windows.today.calls <= windows.month.calls, 'today ⊆ month');
  assert.ok(windows.month.calls <= windows.all.calls, 'month ⊆ all');
  assert.ok(windows.today.totalCny <= windows.month.totalCny, 'today ⊆ month, in money too');
  assert.ok(windows.month.totalCny <= windows.all.totalCny, 'month ⊆ all, in money too');
});

test('T3 a session that began today is contained in today, which is contained in everything', () => {
  // The containment the test plan asks for holds for a session that started today — the
  // normal case, but not a universal law: a long session spans several days, and one day
  // holds several sessions. Naming the shape it needs keeps the assertion honest instead
  // of asserting something that happens to be true of this fixture.
  const state = ledgerOf([
    ['2026-09-16T02:00:00Z'], // this session, peak
    ['2026-09-16T05:00:00Z'], // this session, off-peak
    ['2026-09-16T03:00:00Z', { sessionId: 'session-b' }], // another session, same day
  ]);
  const windows = spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-a' });
  assert.equal(windows.session.calls, 2);
  assert.equal(windows.today.calls, 3);
  assert.equal(windows.month.calls, 3);
  assert.equal(windows.all.calls, 3);
  assert.equal(formatYuan(windows.session.totalCny), '15.060', '¥10.04 peak + ¥5.02 off-peak');
  assert.equal(formatYuan(windows.today.totalCny), '25.100', '¥15.06 this session + ¥10.04 from the other');
  assert.equal(formatYuan(windows.session.peakCny), '10.040');
  assert.equal(formatYuan(windows.session.offPeakCny), '5.020');
  assert.ok(windows.session.calls <= windows.today.calls, 'session ⊆ today');
  assert.ok(windows.today.calls <= windows.month.calls, 'today ⊆ month');
  assert.ok(windows.month.calls <= windows.all.calls, 'month ⊆ all');
});

test('T3 an unknown session id reports zero rather than borrowing another session', () => {
  const state = ledgerOf([['2026-09-16T02:00:00Z']]);
  const windows = spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-b' });
  assert.equal(windows.session.totalCny, 0, 'attributing one session to another would be worse than showing nothing');
  assert.equal(windows.today.totalCny, 10.04, 'but the day window still knows');
});

test('T3 an unpriced model adds calls but no money, and is named', () => {
  const state = ledgerOf([['2026-09-16T02:00:00Z']], { model: 'brand-new-model' });
  const windows = spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-a' });
  assert.equal(windows.all.calls, 1);
  assert.equal(windows.all.unpricedCalls, 1);
  assert.equal(windows.all.totalCny, 0, 'no price must not become a price of zero');
  assert.deepEqual(unpricedModels(state), ['brand-new-model']);
});

test('T3 malformed token counts are neutralised rather than poisoning the totals', () => {
  assert.equal(sanitizeTokens(Number.NaN), 0);
  assert.equal(sanitizeTokens(Number.POSITIVE_INFINITY), 0);
  assert.equal(sanitizeTokens(-5), 0);
  assert.equal(sanitizeTokens('120'), 120);
  assert.equal(sanitizeTokens(12.7), 12);
  assert.equal(sanitizeTokens(undefined), 0);

  const state = createLedgerState();
  reduceRecord(
    state,
    makeRecord({
      atMs: at('2026-09-16T02:00:00Z'),
      model: 'deepseek-flash',
      sessionId: 'session-a',
      tokens: { cacheMiss: Number.NaN, cacheHit: 1_000_000, cacheWrite: -1, output: 1_000_000 },
    }),
  );
  const windows = spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-a' });
  // Only the hit (0.04) and the output (8) survive; the NaN and the negative become 0.
  assert.equal(windows.all.totalCny, 8.04);
  assert.equal(Number.isFinite(windows.all.totalCny), true);
});

test('T3 a record naming an unknown tier is refused, not miscounted', () => {
  const state = createLedgerState();
  const accepted = reduceRecord(state, {
    atMs: at('2026-09-16T02:00:00Z'),
    sessionId: 'session-a',
    model: 'deepseek-flash',
    tier: 'twilight',
    tokens: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 },
    status: 'completed',
    costCny: 1,
  });
  assert.equal(accepted, false);
  assert.equal(spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-a' }).session.calls, 0);
});

test('T3 an interrupted call still costs money', () => {
  const state = createLedgerState();
  reduceRecord(
    state,
    makeRecord({
      atMs: at('2026-09-16T02:00:00Z'),
      model: 'deepseek-flash',
      sessionId: 'session-a',
      tokens: oneMillionEach(),
      status: 'interrupted',
    }),
  );
  const windows = spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z'), sessionId: 'session-a' });
  assert.equal(windows.session.totalCny, 10.04, 'an interrupted call was still billed by the provider');
});

test('T3 the amount is frozen into the record, so history does not move when prices change', () => {
  const record = makeRecord({ atMs: at('2026-09-16T02:00:00Z'), model: 'deepseek-flash', tokens: oneMillionEach() });
  assert.equal(record.costCny, 10.04);
  assert.equal(record.currency, 'CNY');
  const state = createLedgerState();
  reduceRecord(state, record);
  // Simulate a later price correction by re-reading the stored record rather than
  // re-pricing it: the ledger must still report what was actually charged.
  assert.equal(spendWindows(state, { nowMs: at('2026-09-16T09:00:00Z') }).all.totalCny, 10.04);
});

test('T3 pruneDays drops only whole days outside every displayable window', () => {
  const state = ledgerOf([
    ['2026-09-16T02:00:00Z'],
    ['2026-09-01T02:00:00Z'],
    ['2026-01-05T02:00:00Z'],
  ]);
  assert.equal(Object.keys(state.days).length, 3);
  const dropped = pruneDays(state, at('2026-02-01T00:00:00Z'));
  assert.equal(dropped, 1, 'only January is before the cutoff');
  assert.equal(Object.keys(state.days).length, 2);
});

test('T3 slideOf tolerates a missing bucket', () => {
  assert.deepEqual(slideOf(undefined), {
    peakCny: 0,
    offPeakCny: 0,
    totalCny: 0,
    calls: 0,
    unpricedCalls: 0,
    currency: 'CNY',
  });
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
