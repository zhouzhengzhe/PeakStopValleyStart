/**
 * DeepSeek's peak/off-peak price table, and the one place a token count becomes money.
 *
 * **Single source of truth.** Nothing else in this plugin may carry a DeepSeek price.
 * The brake already owns the *time* half of the tariff (`lib/time-window.js`); this
 * module owns the *money* half, and the two meet only through the `'peak' | 'off-peak'`
 * vocabulary they share. That shared spelling is deliberate: if this module invented its
 * own word for the tier, a mismatch would be a silent wrong number rather than a crash.
 *
 * Official basis (https://api-docs.deepseek.com/zh-cn/quick_start/pricing, checked
 * {@link PRICE_TABLE_AS_OF}). The Chinese page lists CNY directly, so these are the
 * published list prices and **not** a currency conversion — there is no exchange rate
 * anywhere in this plugin.
 *
 *   deepseek-flash    cache-hit  ¥0.02 / ¥0.04   cache-miss  ¥1 / ¥2   output  ¥4 / ¥8
 *   deepseek-v4-pro   cache-hit  ¥0.15 / ¥0.30   cache-miss  ¥4.5 / ¥9  output ¥13.5 / ¥27
 *                              (off-peak / peak, per 1M tokens)
 *
 * Footnote 3 of that page — "空闲时段价格为高峰时段价格的一半；高峰时段为北京时间
 * 周一至周五 9:00-12:00、14:00-18:00" — is exactly `OFFICIAL_PEAK_WINDOWS` in
 * `time-window.js`, so the schedule and the prices already agree.
 *
 * @module peak-valley-brake/price-table
 */

/** Where every number in this file came from, for the settings page and for audits. */
export const PRICE_SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

/** The date these prices were read off the official page. */
export const PRICE_TABLE_AS_OF = '2026-09-16';

/** DeepSeek bills in yuan, and so does the account balance this plugin displays. */
export const PRICE_CURRENCY = 'CNY';

/** The prices are quoted per this many tokens. */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * The tariff tiers, spelled exactly as `time-window.js` spells its phases.
 *
 * @type {readonly string[]}
 */
export const TARIFF_TIERS = Object.freeze(['peak', 'off-peak']);

/**
 * Build one frozen rate row.
 *
 * @param {number} cacheMiss - yuan per 1M uncached input tokens.
 * @param {number} cacheHit - yuan per 1M cache-read input tokens.
 * @param {number} output - yuan per 1M output tokens.
 * @returns {Readonly<{cacheMiss: number, cacheHit: number, output: number}>} the row.
 */
function rates(cacheMiss, cacheHit, output) {
  return Object.freeze({ cacheMiss, cacheHit, output });
}

/**
 * Flash's row. DeepSeek-V4.1-Flash, and the two retired aliases billed at its price.
 *
 * @type {Readonly<Record<string, object>>}
 */
const FLASH = Object.freeze({
  peak: rates(2, 0.04, 8),
  'off-peak': rates(1, 0.02, 4),
});

/** DeepSeek-V4-Pro's row. */
const PRO = Object.freeze({
  peak: rates(9, 0.3, 27),
  'off-peak': rates(4.5, 0.15, 13.5),
});

/**
 * Model name → its two rate rows.
 *
 * **Only models the official page currently prices are listed.** A model name that is
 * absent is priced as `undefined` and lands in the ledger's "unpriced" bucket, where it
 * is visible — never guessed at. A guessed price is worse than no price: it is a wrong
 * number that looks like a right one, and the operator would have no way to tell.
 *
 * The two aliases are here because footnote 1 of the official page states them
 * explicitly ("请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费"), so
 * pricing them is reading the page rather than extrapolating from it.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, object>>>>}
 */
export const PRICE_TABLE = Object.freeze({
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-v4-pro': PRO,
});

/**
 * Look up the rate row for a model at a tier.
 *
 * @param {string} model - the model name as the provider reports it.
 * @param {string} tier - `'peak'` or `'off-peak'`.
 * @returns {{cacheMiss: number, cacheHit: number, output: number}|undefined} the row, or undefined when unpriced.
 */
export function ratesFor(model, tier) {
  const byTier = PRICE_TABLE[model];
  if (byTier === undefined) return undefined;
  return byTier[tier];
}

/**
 * Whether this plugin knows how to price a model at all.
 *
 * @param {string} model - the model name.
 * @returns {boolean} true when at least one tier is priced.
 */
export function isPriced(model) {
  return PRICE_TABLE[model] !== undefined;
}

/**
 * Turn one call's token counts into money.
 *
 * `cacheWrite` is charged at the **cache-miss** rate, because a token being written to
 * the cache is by definition an input token that missed. That is also how the provider
 * bills it, and it matters here because the alternative — pricing cache writes at zero —
 * would quietly under-report any model that separates them.
 *
 * No rounding: a ledger sums hundreds of these, and rounding each one first would turn
 * per-call rounding error into a visible drift in the session total. Rounding belongs at
 * the display edge, once.
 *
 * @param {string} model - the model name.
 * @param {string} tier - `'peak'` or `'off-peak'`.
 * @param {{cacheMiss: number, cacheHit: number, cacheWrite: number, output: number}} tokens - the call's token counts.
 * @returns {number|undefined} yuan, or undefined when the model is unpriced.
 */
export function costOfUsage(model, tier, tokens) {
  const row = ratesFor(model, tier);
  if (row === undefined) return undefined;
  const billedAtMissRate = tokens.cacheMiss + tokens.cacheWrite;
  const units =
    billedAtMissRate * row.cacheMiss + tokens.cacheHit * row.cacheHit + tokens.output * row.output;
  return units / TOKENS_PER_PRICE_UNIT;
}

/**
 * Render an amount the way the info bar shows it.
 *
 * Three decimals because a single cheap call is a fraction of a fen, and a column of
 * `¥0.00` would hide exactly the calls an operator is trying to see.
 *
 * @param {number} yuan - the amount.
 * @returns {string} the formatted amount, without a currency symbol.
 */
export function formatYuan(yuan) {
  const value = Number.isFinite(yuan) ? yuan : 0;
  return value.toFixed(3);
}
