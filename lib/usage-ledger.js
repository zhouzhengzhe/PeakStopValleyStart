/**
 * The spend ledger: what each model call cost, and how much of it was peak-priced.
 *
 * This module holds the accounting rules, and it is deliberately **the only** place
 * spend is computed. The host collector's whole job is to hand it records; the info bar's
 * whole job is to render what it returns. That keeps correctness in a layer that can be
 * tested in microseconds with no clock, no network and no files.
 *
 * ## Two decisions worth knowing before reading the code
 *
 * **A record is stamped with its tier when the call *starts*.** A call that begins at
 * 08:59 UTC and ends at 09:01 UTC is billed as off-peak, because that is the tier it was
 * accepted at. Deriving the tier at completion would silently move money across the
 * peak/off-peak divide, which is the one number this plugin exists to report.
 *
 * **The amount is frozen into the record, not recomputed later.** Historical totals must
 * not change because the price table was corrected. A record therefore carries its own
 * `costCny`; re-pricing history is a deliberate migration, never a side effect of an edit.
 *
 * ## Time zone
 *
 * Day and month boundaries are computed in **UTC+8**, the zone the tariff itself is
 * published in. Using the operator's local zone would be defensible for a generic spend
 * counter, but not for this one: a "day" whose peak/off-peak split straddles two tariff
 * days would make the per-day peak/off-peak figures meaningless. The same zone drives the
 * countdown, so a displayed day and a displayed tier always agree.
 *
 * @module peak-valley-brake/usage-ledger
 */

import { isPeakAt } from './time-window.js';
import { costOfUsage, PRICE_CURRENCY } from './price-table.js';

/** Bumped when the persisted shape changes incompatibly. */
export const LEDGER_VERSION = 1;

/** Minutes to add to UTC to reach the tariff's authority zone (Beijing, UTC+8). */
export const TARIFF_UTC_OFFSET_MINUTES = 8 * 60;

/** Milliseconds per minute, for the zone shift. */
const MS_PER_MINUTE = 60_000;

/** How many unpriced model names to remember, so the bar can name them without growing without bound. */
const UNPRICED_MODEL_LIMIT = 20;

/**
 * One tariff tier's running totals inside a bucket.
 *
 * @typedef {object} LedgerSlot
 * @property {number} cacheMiss - uncached input tokens.
 * @property {number} cacheHit - cache-read input tokens.
 * @property {number} cacheWrite - cache-write input tokens.
 * @property {number} output - output tokens.
 * @property {number} costCny - yuan, summed from frozen per-record amounts.
 * @property {number} calls - calls that landed in this tier.
 */

/**
 * One aggregation bucket — a session, or a day.
 *
 * @typedef {object} LedgerBucket
 * @property {LedgerSlot} peak - the peak-priced slot.
 * @property {LedgerSlot} off-peak - the off-peak-priced slot.
 * @property {number} calls - calls in both slots.
 * @property {number} unpricedCalls - calls whose model had no known price; contributes no money anywhere.
 */

/**
 * A four-window spend figure.
 *
 * @typedef {object} SpendSlide
 * @property {number} peakCny - yuan spent at peak rates.
 * @property {number} offPeakCny - yuan spent at off-peak rates.
 * @property {number} totalCny - `peakCny + offPeakCny`, by construction.
 * @property {number} calls - priced and unpriced calls alike.
 * @property {number} unpricedCalls - how many of those contributed no money.
 * @property {string} currency - always `CNY`.
 */

/** Build a zeroed slot. @returns {LedgerSlot} the slot. */
function emptySlot() {
  return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, costCny: 0, calls: 0 };
}

/** Build a zeroed bucket. @returns {LedgerBucket} the bucket. */
function emptyBucket() {
  return { peak: emptySlot(), 'off-peak': emptySlot(), calls: 0, unpricedCalls: 0 };
}

/**
 * Build an empty ledger.
 * @returns {{version: number, sessions: object, days: object, unpricedModels: string[]}} the state.
 */
export function createLedgerState() {
  return { version: LEDGER_VERSION, sessions: Object.create(null), days: Object.create(null), unpricedModels: [] };
}

/**
 * Coerce a token count into something safe to add.
 *
 * `NaN`, `Infinity`, negatives and non-numbers all become 0. A provider that reports a
 * nonsense count must not be able to poison a running total with `NaN`, which would then
 * spread to every later sum and turn the whole ledger into `NaN` for the session.
 *
 * @param {unknown} value - the reported count.
 * @returns {number} a non-negative finite number.
 */
export function sanitizeTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.floor(count);
}

/**
 * The tariff tier of an instant.
 *
 * Delegates to the brake's own window table rather than restating the schedule, so the
 * prices charged and the requests held can never disagree about what "peak" means.
 *
 * @param {number} atMs - the instant, normally the moment the call was initiated.
 * @returns {'peak'|'off-peak'} the tier.
 */
export function tierAt(atMs) {
  return isPeakAt(atMs) ? 'peak' : 'off-peak';
}

/**
 * The tariff-zone calendar day of an instant, as `YYYY-MM-DD`.
 * @param {number} atMs - the instant.
 * @returns {string} the day key.
 */
export function dayKey(atMs) {
  const shifted = new Date(atMs + TARIFF_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/**
 * The tariff-zone calendar month of an instant, as `YYYY-MM`.
 * @param {number} atMs - the instant.
 * @returns {string} the month key.
 */
export function monthKey(atMs) {
  return dayKey(atMs).slice(0, 7);
}

/**
 * Build a record for one model call.
 *
 * @param {object} input - the call.
 * @param {number} input.atMs - when the call was initiated.
 * @param {string} input.model - the model the provider reported.
 * @param {{cacheMiss?: number, cacheHit?: number, cacheWrite?: number, output?: number}} input.tokens - reported counts.
 * @param {'completed'|'interrupted'} [input.status] - how the stream ended.
 * @param {string} [input.sessionId] - the owning session, when one is known.
 * @returns {object} the record, with its tier and its frozen amount.
 */
export function makeRecord(input) {
  const tokens = {
    cacheMiss: sanitizeTokens(input.tokens?.cacheMiss),
    cacheHit: sanitizeTokens(input.tokens?.cacheHit),
    cacheWrite: sanitizeTokens(input.tokens?.cacheWrite),
    output: sanitizeTokens(input.tokens?.output),
  };
  const tier = tierAt(input.atMs);
  const costCny = costOfUsage(input.model, tier, tokens);
  return {
    atMs: input.atMs,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    model: typeof input.model === 'string' ? input.model : '',
    tier,
    tokens,
    status: input.status === 'interrupted' ? 'interrupted' : 'completed',
    // Absent — not zero — when the model is unpriced. The difference matters: 0 would be
    // a claim that the call was free, and there is no such thing.
    ...(costCny === undefined ? {} : { costCny, currency: PRICE_CURRENCY }),
  };
}

/**
 * Add one record's numbers into a bucket's matching tier slot.
 *
 * @param {LedgerBucket} bucket - the bucket to grow.
 * @param {object} record - the record.
 * @returns {boolean} false when the record named a tier this ledger does not know.
 */
function accumulate(bucket, record) {
  const slot = bucket[record.tier];
  // Refuse rather than miscount. A record carrying an unknown tier is a programming
  // error, and quietly filing it under a real tier would corrupt the one figure this
  // plugin exists to report.
  if (slot === undefined) return false;
  slot.cacheMiss += record.tokens.cacheMiss;
  slot.cacheHit += record.tokens.cacheHit;
  slot.cacheWrite += record.tokens.cacheWrite;
  slot.output += record.tokens.output;
  slot.calls += 1;
  bucket.calls += 1;
  if (record.costCny === undefined) {
    bucket.unpricedCalls += 1;
  } else {
    slot.costCny += record.costCny;
  }
  return true;
}

/**
 * File a record into the session bucket and the day bucket.
 *
 * Mutates `state` and returns it. This is a reducer on the model-call hot path, so it
 * copies nothing: rebuilding a growing object graph on every call would be the one place
 * this plugin could slow the model down.
 *
 * @param {object} state - the ledger to grow.
 * @param {object} record - the record, normally from {@link makeRecord}.
 * @returns {boolean} false when the record was refused.
 */
export function reduceRecord(state, record) {
  if (record === null || typeof record !== 'object' || !Number.isFinite(record.atMs)) return false;
  const sessionId = record.sessionId === '' ? '' : record.sessionId;
  if (state.sessions[sessionId] === undefined) state.sessions[sessionId] = emptyBucket();
  const day = dayKey(record.atMs);
  if (state.days[day] === undefined) state.days[day] = emptyBucket();

  const accepted = accumulate(state.sessions[sessionId], record);
  accumulate(state.days[day], record);
  if (!accepted) return false;

  if (record.costCny === undefined && !state.unpricedModels.includes(record.model)) {
    if (state.unpricedModels.length < UNPRICED_MODEL_LIMIT) state.unpricedModels.push(record.model);
  }
  return true;
}

/**
 * Fold one bucket into the four-window shape the bar renders.
 *
 * @param {LedgerBucket|undefined} bucket - the bucket, or undefined when nothing matched.
 * @returns {SpendSlide} the figures; all zero when the bucket is missing.
 */
export function slideOf(bucket) {
  const peakCny = bucket === undefined ? 0 : bucket.peak.costCny;
  const offPeakCny = bucket === undefined ? 0 : bucket['off-peak'].costCny;
  return {
    peakCny,
    offPeakCny,
    // Summed from the same two numbers rather than from a third accumulator, so the
    // invariant "peak + off-peak ≡ total" holds exactly instead of approximately.
    totalCny: peakCny + offPeakCny,
    calls: bucket === undefined ? 0 : bucket.calls,
    unpricedCalls: bucket === undefined ? 0 : bucket.unpricedCalls,
    currency: PRICE_CURRENCY,
  };
}

/** Fold every day bucket into one. @param {object} state - the ledger. @returns {LedgerBucket} the total. */
function foldDays(state, keep) {
  const total = emptyBucket();
  for (const key of Object.keys(state.days)) {
    if (keep !== undefined && !keep(key)) continue;
    const bucket = state.days[key];
    for (const tier of ['peak', 'off-peak']) {
      const from = bucket[tier];
      const into = total[tier];
      into.cacheMiss += from.cacheMiss;
      into.cacheHit += from.cacheHit;
      into.cacheWrite += from.cacheWrite;
      into.output += from.output;
      into.costCny += from.costCny;
      into.calls += from.calls;
    }
    total.calls += bucket.calls;
    total.unpricedCalls += bucket.unpricedCalls;
  }
  return total;
}

/**
 * The four spend windows the info bar reports.
 *
 * There is no `sessionController`-dependent history here: a session window is built from
 * the records this process actually saw. When a session id is unknown the window reports
 * zero rather than falling back to "the most recent session", because attributing one
 * session's spend to another is worse than showing nothing.
 *
 * @param {object} state - the ledger.
 * @param {object} options - the query.
 * @param {number} options.nowMs - the instant the windows are measured from.
 * @param {string} [options.sessionId] - the live session, when known.
 * @returns {{session: SpendSlide, today: SpendSlide, month: SpendSlide, all: SpendSlide}} the windows.
 */
export function spendWindows(state, options) {
  const nowMs = options.nowMs;
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
  const today = dayKey(nowMs);
  const month = monthKey(nowMs);
  return {
    session: slideOf(sessionId === '' ? undefined : state.sessions[sessionId]),
    today: slideOf(foldDays(state, (key) => key === today)),
    month: slideOf(foldDays(state, (key) => key.startsWith(month))),
    all: slideOf(foldDays(state)),
  };
}

/**
 * The models this ledger could not price.
 *
 * Surfaced so the bar can say so. An unlisted model that quietly contributed zero would
 * make the total wrong in a way the operator could not see.
 *
 * @param {object} state - the ledger.
 * @returns {string[]} the model names, oldest first.
 */
export function unpricedModels(state) {
  return [...state.unpricedModels];
}

/**
 * Drop day buckets older than a cutoff, so the file cannot grow without bound.
 *
 * Whole days only, and the cutoff is inclusive, so a bucket is removed only once no
 * window the bar can display still needs it.
 *
 * @param {object} state - the ledger to prune.
 * @param {number} beforeMs - drop days strictly before this instant's day.
 * @returns {number} how many day buckets were dropped.
 */
export function pruneDays(state, beforeMs) {
  const cutoff = dayKey(beforeMs);
  let dropped = 0;
  for (const key of Object.keys(state.days)) {
    if (key < cutoff) {
      delete state.days[key];
      dropped += 1;
    }
  }
  return dropped;
}
