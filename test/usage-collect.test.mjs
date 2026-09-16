/**
 * Self-check for the host-side collector: the model-stream tap and the balance cache.
 *
 * Run with `node test/usage-collect.test.mjs`. No runner, no dependencies, no network —
 * the fetch implementation is injected everywhere it is needed.
 *
 * The stream cases are the ones that matter most. `llm/stream` is on the path of every
 * model call, so a defect here does not degrade a readout, it damages the conversation.
 * Each rule the tap promises has a case below that fails if the rule is dropped:
 *
 *   - chunks pass through unchanged  -> "N in, N out" and identity comparisons
 *   - usage is a snapshot            -> "several usage chunks bill once"
 *   - an upstream failure is not ours-> "no record, and the error still arrives"
 *   - bookkeeping cannot break a call-> "a throwing sink still yields every chunk"
 *
 * @module peak-valley-brake/test/usage-collect
 */

import assert from 'node:assert/strict';

import { tierAt } from '../lib/usage-ledger.js';
import {
  BALANCE_RETRY_BASE_MS,
  BALANCE_RETRY_MAX_MS,
  BALANCE_TTL_MS,
  balanceAfterFailure,
  balanceAfterSuccess,
  createBalanceState,
  failureKindForStatus,
  hasUsageTokens,
  nextBalanceAttemptAt,
  parseAmount,
  parseDeepSeekBalance,
  requestDeepSeekBalance,
  shouldAttemptBalance,
  tapUsage,
  tokensFromUsage,
} from '../lib/usage-collect.js';

/** Counters for the hand-rolled runner. */
const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
 * @param {string} name - the case name.
 * @param {() => (void|Promise<void>)} body - assertions to run; may be async.
 * @returns {Promise<void>} resolves when the case has been recorded.
 */
async function test(name, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Drive a tap to exhaustion and collect everything it produced.
 * @param {() => Promise<AsyncIterable<object>>} open - the upstream opener.
 * @param {object} context - the tap context.
 * @param {Array<object>} sink - receives records.
 * @returns {Promise<{yielded: object[], error: unknown}>} what came out, and how it ended.
 */
async function drain(open, context, sink) {
  const yielded = [];
  let error;
  try {
    for await (const chunk of tapUsage(open, context, (record) => sink.push(record))) yielded.push(chunk);
  } catch (caught) {
    error = caught;
  }
  return { yielded, error };
}

/**
 * Build an async iterable over fixed chunks.
 * @param {object[]} chunks - the chunks.
 * @returns {AsyncIterable<object>} the iterable.
 */
async function* fromChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

/** One million of everything, so a priced record lands on a readable number. */
const FULL_USAGE = {
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
  outputTokens: 1_000_000,
};

/**
 * A peak instant — Wednesday 2026-09-16, 02:00 UTC, inside the 01:00-04:00 window.
 *
 * Worth naming and checking rather than writing `1000` inline: an arbitrary epoch value
 * lands wherever it lands, and a pricing assertion built on it fails as a pricing bug
 * when the real mistake was the clock.
 */
const PEAK_AT = Date.parse('2026-09-16T02:00:00Z');

// ---------------------------------------------------------------------------
// Fixture integrity, first so a wrong clock fails as a wrong clock.
// ---------------------------------------------------------------------------

await test('fixtures: the peak instant really is peak, and the skewed one really is not', () => {
  assert.equal(tierAt(PEAK_AT), 'peak', 'PEAK_AT must be inside a peak window');
  assert.equal(tierAt(1000), 'off-peak', 'the arbitrary epoch instant is off-peak, which is why it was wrong');
});

// ---------------------------------------------------------------------------
// Usage chunk reading
// ---------------------------------------------------------------------------

await test('the usage reader prefers the uncached field over the total', () => {
  // Some adapters report total input (cache hits included) in `inputTokens`, and some
  // report only the uncached part. Reading the total as the uncached part would charge
  // every cached token a second time at the expensive rate.
  const tokens = tokensFromUsage({ uncachedInputTokens: 10, inputTokens: 999, cacheReadTokens: 5, outputTokens: 7 });
  assert.equal(tokens.cacheMiss, 10, 'the uncached field wins when both are present');
  assert.equal(tokens.cacheHit, 5);
  assert.equal(tokens.output, 7);
  const fallback = tokensFromUsage({ inputTokens: 42 });
  assert.equal(fallback.cacheMiss, 42, 'and it falls back when only the total was reported');
});

await test('the usage reader neutralises nonsense counts', () => {
  const tokens = tokensFromUsage({
    uncachedInputTokens: Number.NaN,
    cacheReadTokens: Number.POSITIVE_INFINITY,
    cacheWriteTokens: -3,
    outputTokens: '8',
  });
  assert.deepEqual(tokens, { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 8 });
});

await test('a usage object with no counts at all is not usage', () => {
  assert.equal(hasUsageTokens({}), false);
  assert.equal(hasUsageTokens({ cost: 0.5 }), false);
  assert.equal(hasUsageTokens(null), false);
  assert.equal(hasUsageTokens({ outputTokens: 0 }), true, 'a reported zero is still a report');
});

// ---------------------------------------------------------------------------
// T4 · The stream tap
// ---------------------------------------------------------------------------

await test('T4 a completed call produces exactly one record', async () => {
  const sink = [];
  const chunks = [{ type: 'text', text: 'hello' }, { type: 'usage', usage: FULL_USAGE }, { type: 'finish' }];
  const { yielded, error } = await drain(() => Promise.resolve(fromChunks(chunks)), { atMs: PEAK_AT, model: 'deepseek-flash' }, sink);
  assert.equal(error, undefined);
  assert.equal(yielded.length, 3);
  assert.equal(sink.length, 1, 'exactly one record');
  assert.equal(sink[0].status, 'completed');
  assert.equal(sink[0].costCny, 10.04, 'peak-flash pricing applied');
  assert.equal(sink[0].atMs, PEAK_AT, 'stamped with the initiating instant');
  assert.equal(sink[0].model, 'deepseek-flash');
});

await test('T4 several usage chunks bill once, and the last one wins', async () => {
  // This is the duplicate-billing bug in its natural habitat: usage chunks are cumulative
  // snapshots, so adding them up charges a single call several times over.
  const sink = [];
  const chunks = [
    { type: 'usage', usage: { uncachedInputTokens: 100, outputTokens: 10 } },
    { type: 'usage', usage: { uncachedInputTokens: 500, outputTokens: 50 } },
    { type: 'usage', usage: FULL_USAGE },
    { type: 'finish' },
  ];
  const { yielded } = await drain(() => Promise.resolve(fromChunks(chunks)), { atMs: PEAK_AT, model: 'deepseek-flash' }, sink);
  assert.equal(yielded.length, 4);
  assert.equal(sink.length, 1, 'one record, not three');
  assert.equal(sink[0].tokens.cacheMiss, 1_000_000, 'the snapshot, not the sum');
  assert.equal(sink[0].costCny, 10.04, 'priced from the final snapshot alone');
});

await test('T4 every chunk is yielded, unchanged and in order', async () => {
  const sink = [];
  const chunks = [
    { type: 'text', text: 'a' },
    { type: 'usage', usage: FULL_USAGE },
    { type: 'text', text: 'b' },
    { type: 'finish' },
    { type: 'text', text: 'c' },
  ];
  const { yielded } = await drain(() => Promise.resolve(fromChunks(chunks)), { atMs: 1, model: 'm' }, sink);
  assert.equal(yielded.length, chunks.length, 'the tap must not swallow or duplicate chunks');
  for (let index = 0; index < chunks.length; index += 1) {
    assert.equal(yielded[index], chunks[index], `chunk ${index} must be the very same object`);
  }
});

await test('T4 an upstream that refuses to start records nothing and still throws', async () => {
  const sink = [];
  const boom = new Error('provider refused');
  const { yielded, error } = await drain(
    () => Promise.reject(boom),
    { atMs: PEAK_AT, model: 'deepseek-flash' },
    sink,
  );
  assert.equal(yielded.length, 0);
  assert.equal(error, boom, 'the error must reach the caller unchanged');
  assert.equal(sink.length, 0, 'a call that never started must not invent a charge');
});

await test('T4 a stream that breaks mid-flight still charges, marked interrupted', async () => {
  const sink = [];
  const boom = new Error('connection reset');
  async function* broken() {
    yield { type: 'usage', usage: FULL_USAGE };
    throw boom;
  }
  const { yielded, error } = await drain(() => Promise.resolve(broken()), { atMs: PEAK_AT, model: 'deepseek-flash' }, sink);
  assert.equal(yielded.length, 1);
  assert.equal(error, boom, 'the failure is the caller’s to handle');
  assert.equal(sink.length, 1, 'the provider served those tokens and will bill for them');
  assert.equal(sink[0].status, 'interrupted');
  assert.equal(sink[0].costCny, 10.04);
});

await test('T4 a stream that ends without a finish chunk is interrupted, not completed', async () => {
  const sink = [];
  const { error } = await drain(
    () => Promise.resolve(fromChunks([{ type: 'usage', usage: FULL_USAGE }, { type: 'text', text: 'cut off' }])),
    { atMs: PEAK_AT, model: 'deepseek-flash' },
    sink,
  );
  assert.equal(error, undefined, 'no exception: the stream simply stopped');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].status, 'interrupted', 'silence is not success');
});

await test('T4 no usage chunk means no record and no complaint', async () => {
  const sink = [];
  const { yielded, error } = await drain(
    () => Promise.resolve(fromChunks([{ type: 'text', text: 'hi' }, { type: 'finish' }])),
    { atMs: PEAK_AT, model: 'deepseek-flash' },
    sink,
  );
  assert.equal(yielded.length, 2);
  assert.equal(error, undefined);
  assert.equal(sink.length, 0);
});

await test('T4 a usage chunk carrying no counts produces no record', async () => {
  const sink = [];
  await drain(
    () => Promise.resolve(fromChunks([{ type: 'usage', usage: {} }, { type: 'finish' }])),
    { atMs: PEAK_AT, model: 'deepseek-flash' },
    sink,
  );
  assert.equal(sink.length, 0, 'an empty usage object is not a free call');
});

await test('T4 a throwing sink cannot damage the model output', async () => {
  // The ledger is a report. If writing it fails, the conversation must still finish.
  const chunks = [{ type: 'usage', usage: FULL_USAGE }, { type: 'finish' }];
  const yielded = [];
  let error;
  try {
    for await (const chunk of tapUsage(
      () => Promise.resolve(fromChunks(chunks)),
      { atMs: PEAK_AT, model: 'deepseek-flash' },
      () => {
        throw new Error('disk full');
      },
    )) {
      yielded.push(chunk);
    }
  } catch (caught) {
    error = caught;
  }
  assert.equal(error, undefined, 'the sink’s failure must not escape');
  assert.equal(yielded.length, 2, 'and every chunk still arrives');
});

await test('T4 abandoning the stream early still commits what was served', async () => {
  const sink = [];
  const chunks = [{ type: 'usage', usage: FULL_USAGE }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  for await (const chunk of tapUsage(() => Promise.resolve(fromChunks(chunks)), { atMs: PEAK_AT, model: 'deepseek-flash' }, (r) => sink.push(r))) {
    if (chunk.type === 'usage') break; // the consumer stops reading
  }
  assert.equal(sink.length, 1, 'the provider already served those tokens');
  assert.equal(sink[0].status, 'interrupted');
});

await test('T4 the tier is decided at the initiating instant, not at completion', async () => {
  // Beijing 08:59:59 is off-peak; the call finishes after the 09:00 peak edge. Stamping
  // the record at completion would move this money into the peak column.
  const start = Date.parse('2026-09-16T00:59:59Z');
  const sink = [];
  await drain(
    () => Promise.resolve(fromChunks([{ type: 'usage', usage: FULL_USAGE }, { type: 'finish' }])),
    { atMs: start, model: 'deepseek-flash' },
    sink,
  );
  assert.equal(sink[0].tier, 'off-peak');
  assert.equal(sink[0].costCny, 5.02, 'the off-peak price, decided before the edge');
});

// ---------------------------------------------------------------------------
// T5 · Balance: parsing, caching, and degradation
// ---------------------------------------------------------------------------

await test('T5 the DeepSeek balance reader prefers CNY and falls back to USD', () => {
  const both = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '70.00' },
      { currency: 'CNY', total_balance: '515.00', granted_balance: '15.00', topped_up_balance: '500.00' },
    ],
  });
  assert.equal(both.currency, 'CNY');
  assert.equal(both.total, 515, 'the amount is a string in the payload and must be parsed');
  assert.equal(both.granted, 15);
  assert.equal(both.toppedUp, 500);

  const usdOnly = parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: '3.50' }] });
  assert.equal(usdOnly.currency, 'USD');
  assert.equal(usdOnly.total, 3.5);
});

await test('T5 an unreadable balance is unknown, never zero', () => {
  assert.equal(parseDeepSeekBalance({}), undefined);
  assert.equal(parseDeepSeekBalance({ balance_infos: [] }), undefined);
  assert.equal(parseDeepSeekBalance({ balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] }), undefined);
  assert.equal(parseDeepSeekBalance(null), undefined);
  assert.equal(parseAmount('-1'), undefined, 'a negative balance is not a balance');
  assert.equal(parseAmount('  12.5 '), 12.5);
  assert.equal(parseAmount(''), undefined);
});

await test('T5 a success caches, and no attempt happens before the TTL elapses', () => {
  const fresh = balanceAfterSuccess(createBalanceState(), { currency: 'CNY', total: 515 }, 1_000_000);
  assert.equal(fresh.value, 515);
  assert.equal(shouldAttemptBalance(fresh, 1_000_000, {}), false, 'not immediately');
  assert.equal(shouldAttemptBalance(fresh, 1_000_000 + BALANCE_TTL_MS - 1, {}), false);
  assert.equal(shouldAttemptBalance(fresh, 1_000_000 + BALANCE_TTL_MS, {}), true, 'and yes once stale');
});

await test('T5 a failure keeps the last known balance instead of blanking it', () => {
  // An unreachable balance and an empty balance are opposite facts. Showing ¥0 for the
  // first one is a lie the operator cannot detect.
  const fresh = balanceAfterSuccess(createBalanceState(), { currency: 'CNY', total: 515 }, 1_000_000);
  const failed = balanceAfterFailure(fresh, { kind: 'network', message: 'socket closed' }, 1_100_000);
  assert.equal(failed.value, 515, 'the last good figure survives');
  assert.equal(failed.currency, 'CNY');
  assert.equal(failed.fetchedAtMs, 1_000_000, 'and still reports when it was actually read');
  assert.equal(failed.failure.kind, 'network');
  assert.notEqual(failed.failure, null, 'but the staleness is visible');
  assert.equal(failed.consecutiveFailures, 1);
});

await test('T5 the retry delay doubles and then stops growing', () => {
  let state = createBalanceState();
  let now = 1_000_000;
  const delays = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    state = balanceAfterFailure(state, { kind: 'network', message: 'down' }, now);
    const next = nextBalanceAttemptAt(state, {});
    delays.push(next - now);
    now = next;
  }
  assert.deepEqual(delays.slice(0, 5), [
    BALANCE_RETRY_BASE_MS,
    BALANCE_RETRY_BASE_MS * 2,
    BALANCE_RETRY_BASE_MS * 4,
    BALANCE_RETRY_BASE_MS * 8,
    BALANCE_RETRY_BASE_MS * 16,
  ]);
  assert.equal(delays[delays.length - 1], BALANCE_RETRY_MAX_MS, 'and it is capped, not unbounded');
  assert.ok(
    BALANCE_RETRY_MAX_MS / BALANCE_RETRY_BASE_MS <= 64,
    'the ceiling must stay low enough that a fixed credential is noticed within a coffee break',
  );
});

await test('T5 a later success clears the failure and resets the backoff', () => {
  let state = createBalanceState();
  state = balanceAfterFailure(state, { kind: 'timeout', message: 'slow' }, 1_000_000);
  state = balanceAfterFailure(state, { kind: 'timeout', message: 'slow' }, 2_000_000);
  assert.equal(state.consecutiveFailures, 2);
  state = balanceAfterSuccess(state, { currency: 'CNY', total: 400 }, 3_000_000);
  assert.equal(state.failure, null);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.value, 400);
  assert.equal(shouldAttemptBalance(state, 3_000_000 + BALANCE_TTL_MS, {}), true, 'back to the plain TTL');
});

await test('T5 the fetch failures are distinguishable, including a missing credential', async () => {
  const missing = await requestDeepSeekBalance({ apiKey: '', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'no-credential', 'silence about a missing key is the worst outcome');

  const unauthorized = await requestDeepSeekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(unauthorized.kind, 'unauthorized');
  assert.equal(failureKindForStatus(403), 'unauthorized');
  assert.equal(failureKindForStatus(500), 'http');

  const timedOut = await requestDeepSeekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  assert.equal(timedOut.kind, 'timeout');

  const offline = await requestDeepSeekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  assert.equal(offline.kind, 'network');

  const malformed = await requestDeepSeekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ unexpected: true }) }),
  });
  assert.equal(malformed.kind, 'malformed');
});

await test('T5 a successful request returns the reading', async () => {
  const outcome = await requestDeepSeekBalance({
    apiKey: 'sk-test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '515.75' }] }) }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reading.total, 515.75);
});

await test('T5 the credential never appears in anything reportable', async () => {
  // Every failure path and every success path is checked, because a key leaks most easily
  // through the one branch nobody thought to look at.
  const secret = 'sk-super-secret-value-12345';
  const impls = [
    async () => ({ ok: false, status: 401, json: async () => ({}) }),
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ unexpected: true }) }),
    async () => ({ ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '1' }] }) }),
    async () => {
      throw new Error('boom');
    },
  ];
  for (const impl of impls) {
    const outcome = await requestDeepSeekBalance({ apiKey: secret, fetchImpl: impl });
    const serialised = JSON.stringify(outcome);
    assert.equal(serialised.includes(secret), false, `the key leaked into: ${serialised}`);
  }
});

// ---------------------------------------------------------------------------

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
