/**
 * The info bar's data model: everything the bar shows, derived as a pure function.
 *
 * Rendering lives in `client.js`; deciding *what* to show lives here. That split is what
 * makes the bar testable at all — the client runs in a browser inside a plugin host, and
 * this module runs in microseconds under `node`.
 *
 * Two rules this module exists to enforce:
 *
 * **The tier shown is the billing tier, not the brake's state.** During the pre-peak
 * brace the brake is already holding requests, but a call placed then is still billed at
 * the off-peak rate. Labelling the bar "高峰价" a minute early would make the operator
 * distrust the number that matters.
 *
 * **A peak/off-peak split always adds up to the total beside it.** Both come from one
 * ledger reading, so the two figures cannot disagree.
 *
 * @module peak-valley-brake/info-bar-view
 */

import { nextTierBoundaryAfter } from './time-window.js';
import { formatYuan } from './price-table.js';
import { tierAt } from './usage-ledger.js';

/** Milliseconds per second, for the countdown. */
const MS_PER_SECOND = 1000;

/** How a segment should be drawn. The client maps these onto theme colours. */
export const TONES = Object.freeze(['plain', 'peak', 'off-peak', 'muted', 'warn']);

/**
 * The currency symbol for a currency code.
 * @param {string} currency - `CNY` or `USD`.
 * @returns {string} the symbol, or the code itself when unknown.
 */
export function currencySymbol(currency) {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

/**
 * Render a duration as a countdown.
 *
 * Minutes and seconds under an hour, hours added beyond that. The short form is not
 * cosmetic: this sits in a row of dense figures, and the common case is under an hour.
 *
 * @param {number} ms - milliseconds remaining, possibly `Infinity`.
 * @returns {string} the rendered countdown, or an em dash when there is no next edge.
 */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Describe the account balance for the bar.
 *
 * Three genuinely different situations, kept distinct because collapsing them would tell
 * the operator something false: a known figure, a known figure that is now stale, and no
 * figure at all.
 *
 * @param {object} state - the balance state from `usage-collect.js`.
 * @param {number} nowMs - the current instant.
 * @returns {{text: string, tone: string, title: string}} the segment.
 */
export function balanceSegment(state, nowMs) {
  const symbol = currencySymbol(state.currency);
  if (state.failure !== null && state.value === null) {
    return {
      text: '余额 暂不可用',
      tone: 'warn',
      title: `无法读取余额（${state.failure.kind}）：${state.failure.message}`,
    };
  }
  if (state.value === null) {
    return { text: '余额 —', tone: 'muted', title: '尚未读取余额' };
  }
  const age = state.fetchedAtMs === null ? 0 : Math.max(0, nowMs - state.fetchedAtMs);
  const value = `${symbol}${formatYuan(state.value)}`;
  if (state.failure !== null) {
    // The figure is kept, and said to be old. Blanking it would be indistinguishable
    // from a zero balance, which is the opposite fact.
    return {
      text: `余额 ${value}`,
      tone: 'warn',
      title: `余额暂不可用（${state.failure.kind}），显示 ${Math.round(age / 1000)} 秒前的数据：${state.failure.message}`,
    };
  }
  return { text: `余额 ${value}`, tone: 'plain', title: `余额读取于 ${Math.round(age / 1000)} 秒前` };
}

/**
 * Render one spend window as a single figure.
 * @param {string} label - the row label.
 * @param {object} slide - a `SpendSlide`.
 * @returns {{text: string, tone: string, title: string}} the segment.
 */
export function spendSegment(label, slide) {
  const symbol = currencySymbol(slide.currency);
  const unpriced =
    slide.unpricedCalls > 0 ? `，另有 ${slide.unpricedCalls} 次调用未定价（未计入金额）` : '';
  return {
    text: `${label} ${symbol}${formatYuan(slide.totalCny)}`,
    tone: 'plain',
    title: `${label}合计 ${symbol}${formatYuan(slide.totalCny)}：高峰 ${symbol}${formatYuan(slide.peakCny)}、空闲 ${symbol}${formatYuan(slide.offPeakCny)}，共 ${slide.calls} 次调用${unpriced}`,
  };
}

/**
 * Render the peak/off-peak split of one window.
 *
 * This is the figure the third-party bar could not show, so it is rendered as its own
 * segment rather than hidden behind a tooltip.
 *
 * @param {object} slide - a `SpendSlide`.
 * @returns {{text: string, tone: string, title: string}} the segment.
 */
export function splitSegment(slide) {
  const symbol = currencySymbol(slide.currency);
  return {
    text: `高峰 ${symbol}${formatYuan(slide.peakCny)} · 空闲 ${symbol}${formatYuan(slide.offPeakCny)}`,
    tone: 'plain',
    title: `本会话按计费档拆分：高峰 ${symbol}${formatYuan(slide.peakCny)}，空闲 ${symbol}${formatYuan(slide.offPeakCny)}`,
  };
}

/**
 * Build the whole bar.
 *
 * @param {object} input - the current picture.
 * @param {number} input.nowMs - the current instant.
 * @param {string} [input.model] - the model the session is routed to.
 * @param {string} [input.providerName] - the provider's display name.
 * @param {object} input.balance - the balance state.
 * @param {{session: object, today: object, month: object, all: object}} input.windows - spend windows.
 * @param {readonly object[]} [input.windowsTable] - the peak window table, for the tariff arithmetic.
 * @returns {{segments: object[], spend: object, warnings: string[]}} the view model.
 */
export function buildInfoBar(input) {
  const nowMs = input.nowMs;
  const peak = tierAt(nowMs) === 'peak';
  const nextChangeAt = nextTierBoundaryAfter(nowMs, input.windowsTable);
  const countdown = formatCountdown(nextChangeAt - nowMs);
  const label = peak ? '高峰价' : '空闲价';
  const target = peak ? '距空闲' : '距高峰';

  const segments = [];

  const providerName = input.providerName === undefined || input.providerName === '' ? 'DeepSeek' : input.providerName;
  const model = typeof input.model === 'string' && input.model !== '' ? input.model : '未选择模型';
  segments.push({
    id: 'anchor',
    text: `${providerName} · ${model}`,
    tone: 'plain',
    title: '当前会话使用的服务商与模型',
  });

  segments.push({ id: 'balance', ...balanceSegment(input.balance, nowMs) });
  segments.push({
    id: 'tier',
    text: label,
    tone: peak ? 'peak' : 'off-peak',
    title: peak ? '当前按高峰价计费' : '当前按空闲价计费（高峰价的一半）',
  });
  segments.push({
    id: 'countdown',
    text: `${target} ${countdown}`,
    tone: 'plain',
    title: peak ? '距离转为空闲价还有多久' : '距离转为高峰价还有多久',
  });
  segments.push({ id: 'session', ...spendSegment('本会话', input.windows.session) });
  segments.push({ id: 'split', ...splitSegment(input.windows.session) });

  const warnings = [];
  if (input.balance.failure !== null) warnings.push(`余额：${input.balance.failure.kind}`);
  if (input.windows.session.unpricedCalls > 0) warnings.push('有调用未定价');
  if (input.unpricedModels !== undefined && input.unpricedModels.length > 0) {
    warnings.push(`未定价模型：${input.unpricedModels.join('、')}`);
  }

  return {
    segments,
    spend: {
      session: input.windows.session,
      today: input.windows.today,
      month: input.windows.month,
      all: input.windows.all,
    },
    warnings,
    // Handed over so the client can keep the countdown moving between polls. The instant
    // is the host's decision; the client only counts down to it, which keeps the schedule
    // in one place while the clock still ticks at the speed a clock should.
    tierEndsAtMs: nextChangeAt,
    countdownLabel: target,
    nowMs,
  };
}

/**
 * The rows shown when the operator hovers the session spend.
 *
 * Each window carries its own peak/off-peak split, so the question "how much of this
 * month did I pay peak rates for?" is answerable without arithmetic.
 *
 * @param {object} view - the result of {@link buildInfoBar}.
 * @returns {{label: string, total: string, split: string}[]} the detail rows.
 */
export function spendDetailRows(view) {
  return [
    ['本会话', view.spend.session],
    ['今日', view.spend.today],
    ['近一月', view.spend.month],
    ['全部', view.spend.all],
  ].map(([label, slide]) => {
    const symbol = currencySymbol(slide.currency);
    return {
      label,
      total: `${symbol}${formatYuan(slide.totalCny)}`,
      split: `高峰 ${symbol}${formatYuan(slide.peakCny)} · 空闲 ${symbol}${formatYuan(slide.offPeakCny)}`,
    };
  });
}
