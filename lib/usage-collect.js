/**
 * Host-side collection: turn live model calls into ledger records, and keep the account
 * balance fresh without hammering the API.
 *
 * Two jobs, both of which sit on a path the operator cannot afford to have break:
 *
 * **Accounting rides the model stream.** `llm/stream` is a waterfall every single model
 * call passes through. A mistake here does not degrade a readout — it truncates the
 * model's answer. So the tap below yields every chunk unconditionally, treats the usage
 * chunk as a *snapshot* rather than a delta, commits at most once, and swallows its own
 * bookkeeping errors while letting the upstream's errors travel.
 *
 * **Balance is cached with a backoff.** The account is the operator's, and a readout is
 * not worth a rate-limit. A failure never clears the last known figure: an empty balance
 * and an unreachable balance mean opposite things, and showing `¥0` for the second one
 * would be a lie the operator cannot detect.
 *
 * @module peak-valley-brake/usage-collect
 */

import { makeRecord, sanitizeTokens } from './usage-ledger.js';

/** How long a successful balance reading stays good for. */
export const BALANCE_TTL_MS = 60_000;

/** First retry delay after a failed balance attempt. */
export const BALANCE_RETRY_BASE_MS = 30_000;

/** Ceiling on the balance retry delay, so a fixed credential is picked up within this long. */
export const BALANCE_RETRY_MAX_MS = 15 * 60_000;

/** How long to wait for the balance endpoint before giving up on this attempt. */
export const BALANCE_TIMEOUT_MS = 10_000;

/** The DeepSeek balance endpoint. */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/**
 * Read the model name off a live agent.
 *
 * The accessor is `agent.options.model`, and that is not a guess: the harness's own
 * compaction module reads the conversation target the same way
 * (`dsh-compaction-basic/lib/index.js:726`). Two other spellings —
 * `agent.session.model` and `agent.model` — were tried first and neither exists, so the
 * lookup missed on every call and the bar sat on its placeholder while calls were being
 * made and billed. Anything reaching for the model elsewhere should come through here.
 *
 * Returns `''` rather than `undefined` for "unknown", and callers must test it with a
 * truthiness check. `'' ?? fallback` is `''`, which is precisely how a known model was
 * once thrown away; `??` cannot be used to default this value anywhere.
 *
 * @param {object} [agent] - the agent to inspect; may be absent.
 * @returns {string} the model name, or `''` when the agent does not carry one.
 */
export function modelFromAgent(agent) {
  const model = agent?.options?.model;
  return typeof model === 'string' ? model : '';
}

/**
 * Read the token counts out of a DSH usage chunk.
 *
 * `uncachedInputTokens` is preferred over `inputTokens` because some adapters report the
 * total input (cache hits included) and some report only the uncached part; taking the
 * uncached field when it exists is the only reading that does not double-charge the
 * cached tokens.
 *
 * @param {object} usage - the chunk's `usage` object.
 * @returns {{cacheMiss: number, cacheHit: number, cacheWrite: number, output: number}} the counts.
 */
export function tokensFromUsage(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {};
  return {
    cacheMiss: sanitizeTokens(
      source.uncachedInputTokens !== null && source.uncachedInputTokens !== undefined
        ? source.uncachedInputTokens
        : source.inputTokens,
    ),
    cacheHit: sanitizeTokens(source.cacheReadTokens),
    cacheWrite: sanitizeTokens(source.cacheWriteTokens),
    output: sanitizeTokens(source.outputTokens),
  };
}

/**
 * Whether a usage object carries any token count at all.
 *
 * A usage chunk with no counts must not produce a record: a zero-token record is
 * indistinguishable from a free call once it is in the ledger.
 *
 * @param {object} usage - the chunk's `usage` object.
 * @returns {boolean} true when at least one count was reported.
 */
export function hasUsageTokens(usage) {
  if (usage === null || typeof usage !== 'object') return false;
  return ['uncachedInputTokens', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].some(
    (key) => usage[key] !== null && usage[key] !== undefined,
  );
}

/**
 * Wrap a model stream so that exactly one ledger record comes out of it.
 *
 * The three rules that matter, each of which is a bug that has already been paid for
 * somewhere else:
 *
 * 1. **Chunks pass through untouched.** Yielding anything other than what arrived, or
 *    yielding conditionally, truncates the model's output.
 * 2. **Usage is a snapshot, not a delta.** Keeping the last one and committing once is
 *    correct; summing them bills a single call several times over.
 * 3. **`open()` failing is not an accounting event.** When the upstream refuses to start,
 *    the error propagates and nothing is recorded — a record for a call that never
 *    happened would invent money.
 *
 * The bookkeeping is committed in a `finally`, so a stream abandoned mid-iteration still
 * charges for what the provider already served.
 *
 * @param {() => Promise<AsyncIterable<object>>} open - starts the upstream stream.
 * @param {{atMs: number, model?: string, sessionId?: string}} context - the call's identity; `atMs` is when it was initiated.
 * @param {(record: object) => void} sink - receives the single record, when there is one.
 * @yields {object} every chunk the upstream produced, in order.
 * @returns {Promise<void>} resolves when the stream is exhausted.
 */
export async function* tapUsage(open, context, sink) {
  // Deliberately outside the try: an upstream failure is the caller's to handle, and
  // must not be converted into a record or into a silent empty stream.
  const stream = await open();

  /** The most recent usage snapshot, which is the only one that describes the whole call. */
  let latestUsage = null;
  let sawFinish = false;
  let committed = false;

  /**
   * Record the call once, if there is anything to record.
   * @param {'completed'|'interrupted'} status - how the call ended.
   * @returns {void}
   */
  const commit = (status) => {
    if (committed || latestUsage === null) return;
    committed = true;
    try {
      sink(
        makeRecord({
          atMs: context.atMs,
          model: typeof context.model === 'string' ? context.model : '',
          sessionId: context.sessionId,
          tokens: latestUsage,
          status,
        }),
      );
    } catch {
      // Accounting must never be able to fail a model call. A ledger that is missing a
      // row is a reporting problem; an exception here would be a broken conversation.
    }
  };

  try {
    for await (const chunk of stream) {
      if (chunk !== null && typeof chunk === 'object') {
        if (chunk.type === 'usage' && hasUsageTokens(chunk.usage)) {
          latestUsage = tokensFromUsage(chunk.usage);
        }
        if (chunk.type === 'finish') sawFinish = true;
      }
      yield chunk;
    }
  } catch (error) {
    commit('interrupted');
    throw error;
  } finally {
    commit(sawFinish ? 'completed' : 'interrupted');
  }
}

/**
 * Coerce a JSON amount into a finite non-negative number.
 * @param {unknown} value - the reported amount, usually a string.
 * @returns {number|undefined} the number, or undefined when it is not usable.
 */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Read a DeepSeek balance response.
 *
 * CNY is preferred and USD is the fallback, matching how the account is denominated in
 * practice. Anything unrecognised returns `undefined` rather than a zero: an unparseable
 * response is an unknown balance, not an empty one.
 *
 * @param {unknown} body - the decoded JSON body.
 * @returns {{currency: string, total: number, granted: number, toppedUp: number}|undefined} the reading.
 */
export function parseDeepSeekBalance(body) {
  if (body === null || typeof body !== 'object') return undefined;
  const list = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const usable = (entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    (entry.currency === 'CNY' || entry.currency === 'USD') &&
    parseAmount(entry.total_balance) !== undefined;
  const record = list.find((entry) => usable(entry) && entry.currency === 'CNY') ?? list.find(usable);
  if (record === undefined) return undefined;
  return {
    currency: record.currency,
    total: parseAmount(record.total_balance),
    granted: parseAmount(record.granted_balance) ?? 0,
    toppedUp: parseAmount(record.topped_up_balance) ?? 0,
  };
}

/**
 * Build the balance state machine's initial value.
 * @returns {object} the state.
 */
export function createBalanceState() {
  return {
    value: null,
    currency: 'CNY',
    fetchedAtMs: null,
    lastAttemptAtMs: null,
    consecutiveFailures: 0,
    failure: null,
  };
}

/**
 * When the next balance attempt is allowed.
 *
 * Two different clocks: after a success the reading is simply cached for its TTL; after a
 * failure the delay doubles up to a ceiling. The ceiling matters — without it a permanent
 * failure would back off to effectively never, and a credential the operator fixes an hour
 * later would not show up until the next restart.
 *
 * @param {object} state - the balance state.
 * @param {object} [options] - overrides.
 * @returns {number} the epoch ms at which another attempt is allowed.
 */
export function nextBalanceAttemptAt(state, options = {}) {
  if (state.lastAttemptAtMs === null) return 0;
  if (state.failure === null) return state.lastAttemptAtMs + (options.ttlMs ?? BALANCE_TTL_MS);
  const base = options.retryBaseMs ?? BALANCE_RETRY_BASE_MS;
  const ceiling = options.retryMaxMs ?? BALANCE_RETRY_MAX_MS;
  const delay = Math.min(base * 2 ** Math.max(0, state.consecutiveFailures - 1), ceiling);
  return state.lastAttemptAtMs + delay;
}

/**
 * Whether it is time to ask for the balance again.
 * @param {object} state - the balance state.
 * @param {number} nowMs - the current instant.
 * @param {object} [options] - overrides.
 * @returns {boolean} true when an attempt is allowed now.
 */
export function shouldAttemptBalance(state, nowMs, options = {}) {
  return nowMs >= nextBalanceAttemptAt(state, options);
}

/**
 * Fold a successful reading into the state.
 *
 * @param {object} state - the balance state.
 * @param {{currency: string, total: number, granted: number, toppedUp: number}} reading - the parsed balance.
 * @param {number} nowMs - the current instant.
 * @returns {object} the new state.
 */
export function balanceAfterSuccess(state, reading, nowMs) {
  return {
    value: reading.total,
    currency: reading.currency,
    fetchedAtMs: nowMs,
    lastAttemptAtMs: nowMs,
    consecutiveFailures: 0,
    failure: null,
  };
}

/**
 * Fold a failed attempt into the state.
 *
 * **The last good value survives.** That is the whole point of this function: a failure
 * marks the reading stale, and the view layer shows the old number with a warning rather
 * than a blank or a zero.
 *
 * @param {object} state - the balance state.
 * @param {{kind: string, message: string}} failure - what went wrong; must never contain a credential.
 * @param {number} nowMs - the current instant.
 * @returns {object} the new state.
 */
export function balanceAfterFailure(state, failure, nowMs) {
  return {
    ...state,
    lastAttemptAtMs: nowMs,
    consecutiveFailures: state.consecutiveFailures + 1,
    failure: { kind: failure.kind, message: failure.message },
  };
}

/**
 * Classify an HTTP status into a failure kind the UI can distinguish.
 * @param {number} status - the HTTP status code.
 * @returns {string} the kind.
 */
export function failureKindForStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  return 'http';
}

/**
 * Ask DeepSeek for the account balance.
 *
 * The key is passed in and used only in the request header. It is never put in the
 * returned value, never interpolated into a message, and never logged — every failure
 * path below reports a kind and a short reason and nothing else.
 *
 * @param {object} options - the request.
 * @param {string} options.apiKey - the resolved credential.
 * @param {Function} [options.fetchImpl] - the fetch implementation; injected so tests need no network.
 * @param {number} [options.timeoutMs] - per-attempt timeout.
 * @returns {Promise<{ok: true, reading: object}|{ok: false, kind: string, message: string}>} the outcome.
 */
export async function requestDeepSeekBalance(options) {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, kind: 'network', message: 'no fetch implementation' };
  if (typeof options.apiKey !== 'string' || options.apiKey === '') {
    return { ok: false, kind: 'no-credential', message: 'no credential configured for this provider' };
  }
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS;
  try {
    const response = await doFetch(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, kind: failureKindForStatus(response.status), message: `HTTP ${response.status}` };
    }
    const reading = parseDeepSeekBalance(await response.json());
    if (reading === undefined) return { ok: false, kind: 'malformed', message: 'unrecognised balance response' };
    return { ok: true, reading };
  } catch (error) {
    const name = error !== null && typeof error === 'object' ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, kind: 'timeout', message: 'request timed out' };
    return { ok: false, kind: 'network', message };
  }
}
