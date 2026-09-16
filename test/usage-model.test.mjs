/**
 * Self-check for the model name the info bar shows.
 *
 * Run with `node test/usage-model.test.mjs`. No runner, no dependencies.
 *
 * Two defects produced one symptom: the bar read `DeepSeek · 未选择模型` while the session
 * was demonstrably using a model and the ledger was demonstrably pricing its calls. Each
 * defect could hide the other, so each gets its own assertion here rather than one test
 * that would pass again if either half regressed.
 *
 *   R1/R2  the runtime must not discard a model it has already observed, just because the
 *          agent lookup missed. `'' ?? x` is `''`, which is how the observed model was lost.
 *   A1..A3 the agent lookup must read `agent.options.model` — the accessor the harness's own
 *          compaction module uses (`dsh-compaction-basic/lib/index.js:726`). The two paths
 *          this code originally guessed (`agent.session.model`, `agent.model`) do not exist,
 *          so the lookup missed on every single call.
 *
 * A note on `agent` fixtures: the shape is copied from the harness, not invented. An
 * accessor test whose fixture is a guess proves only that the guess is self-consistent,
 * which is exactly how the original defect survived review.
 *
 * @module peak-valley-brake/test/usage-model
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modelFromAgent } from '../lib/usage-collect.js';
import { createUsageRuntime } from '../lib/usage-runtime.js';

/** Wednesday 15:00 in UTC+8 — inside the peak window, so the tariff branch is exercised. */
const AT_PEAK = Date.parse('2026-09-16T07:00:00Z');

const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
 *
 * Async because the runtime's hook is a generator waterfall; awaiting is what makes the
 * ledger settle before the view is read.
 *
 * @param {string} name - the case name.
 * @param {() => void|Promise<void>} body - assertions to run.
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
 * Build a runtime wired to a fake host, drive one model call through it, and read the bar.
 *
 * @param {object} [options] - the scenario.
 * @param {string} [options.model] - the model named on the call, as `GenerateOptions.model` carries it.
 * @param {() => string} [options.modelFor] - the agent-lookup resolver to inject.
 * @param {Array<object>} [options.chunks] - the chunks the model stream yields.
 * @returns {Promise<{anchor: string, segments: object[], ledger: object, reports: string[]}>} what the bar would render.
 */
async function driveCall(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'peakstop-model-'));
  const reports = [];
  const handlers = new Map();
  const ctx = { on: (name, fn) => handlers.set(name, fn) };

  const runtime = createUsageRuntime({
    home,
    now: () => AT_PEAK,
    report: (message) => reports.push(message),
    sessionIdFor: (hookOptions) => hookOptions?.sessionId,
    modelFor: options.modelFor ?? (() => ''),
  });
  runtime.attach(ctx);

  const handler = handlers.get('llm/stream');
  assert.ok(handler !== undefined, 'the runtime must register an llm/stream handler');

  const stream = handler(
    { provider: 'deepseek', model: options.model ?? 'deepseek-v4-flash', messages: [], sessionId: 'sess-1' },
    async function* () {
      for (const chunk of options.chunks ?? [{ type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } }]) {
        yield chunk;
      }
    },
  );
  for await (const _chunk of stream) {
    /* drain, exactly as the harness does */
  }

  const view = runtime.viewFor('sess-1');
  const anchor = view.segments.find((segment) => segment.id === 'anchor');
  const ledger = runtime.ledgerState();
  await runtime.dispose();
  return { anchor: anchor?.text, segments: view.segments, ledger, reports };
}

process.stdout.write('\nmodel name in the info bar\n');

await test('R1 a miss in the agent lookup still shows the model that was used', async () => {
  const { anchor } = await driveCall({ modelFor: () => '' });
  assert.equal(anchor, 'DeepSeek · deepseek-v4-flash');
});

await test('R2 the model is known from the call itself, before any usage arrives', async () => {
  // A call that reports no usage yet is still a call that names its model. Waiting for the
  // usage chunk would leave the bar blank for the whole first response.
  const { anchor } = await driveCall({ modelFor: () => '', chunks: [{ type: 'text', text: 'hi' }] });
  assert.equal(anchor, 'DeepSeek · deepseek-v4-flash');
});

await test('R3 a lookup that does resolve wins over the last observed model', async () => {
  // The selection is the truth for "what am I about to use"; the last call is only a memory.
  const { anchor } = await driveCall({ modelFor: () => 'deepseek-v4-pro' });
  assert.equal(anchor, 'DeepSeek · deepseek-v4-pro');
});

await test('R4 the placeholder is reserved for a genuinely unknown model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peakstop-model-'));
  const runtime = createUsageRuntime({ home, now: () => AT_PEAK, modelFor: () => '' });
  const view = runtime.viewFor('sess-1');
  const anchor = view.segments.find((segment) => segment.id === 'anchor');
  assert.equal(anchor?.text, 'DeepSeek · 未选择模型');
  await runtime.dispose();
});

await test('A1 the agent accessor reads options.model', () => {
  assert.equal(modelFromAgent({ options: { provider: 'deepseek', model: 'deepseek-v4-flash' } }), 'deepseek-v4-flash');
});

await test('A2 the accessor tolerates an agent that carries no model', () => {
  // Every one of these is a real possibility: no agent resolved, an agent with no options,
  // or an options object whose model is empty. None may throw.
  assert.equal(modelFromAgent(undefined), '');
  assert.equal(modelFromAgent({}), '');
  assert.equal(modelFromAgent({ options: {} }), '');
  assert.equal(modelFromAgent({ options: { model: '' } }), '');
  assert.equal(modelFromAgent({ options: { model: null } }), '');
});

await test('A3 a non-string model never reaches the bar as an object', () => {
  assert.equal(modelFromAgent({ options: { model: 42 } }), '');
  assert.equal(modelFromAgent({ options: { model: { id: 'x' } } }), '');
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
