/**
 * Disposable repro for the blank model name in the info bar.
 *
 * Run from the repo root: `node .spec-workflow/usage-info-bar/bugs/model-name-blank/debug/repro.mjs`
 *
 * Kept because it drives the real runtime end to end — a full `GenerateOptions`-shaped call
 * through the `llm/stream` waterfall, then a read of the bar — which is one layer above the
 * unit-level regression tests in `test/usage-model.test.mjs`. It exits 0 when the model
 * reaches the bar and 1 when it does not.
 *
 * Disposable: delete it once the behaviour is stable, or keep it as a manual smoke check.
 * It is not part of `npm test`; the suite discovers only `test/*.test.mjs`.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = new URL('../../../../../lib/', import.meta.url).href;
const { createUsageRuntime } = await import(`${LIB}usage-runtime.js`);

const home = await mkdtemp(join(tmpdir(), 'peakstop-repro-'));
const reports = [];
const handlers = new Map();
const ctx = { on: (name, fn) => handlers.set(name, fn) };

// Mirrors lib/index.js `modelFor` when the agent lookup misses, which is what it did on
// every call before the fix: it returned '' rather than a model name.
const runtime = createUsageRuntime({
  home,
  now: () => Date.parse('2026-09-16T07:00:00Z'), // Wednesday 15:00 UTC+8 -> peak
  report: (m) => reports.push(m),
  modelFor: () => '',
  sessionIdFor: (o) => o?.sessionId,
});

runtime.attach(ctx);

const handler = handlers.get('llm/stream');
if (handler === undefined) throw new Error('no llm/stream handler registered');

const options = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  messages: [],
  sessionId: 'sess-1',
};

const stream = handler(options, async function* () {
  yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } };
  yield { type: 'finish', reason: 'stop' };
});
for await (const _chunk of stream) {
  /* drain, as the harness does */
}

const view = runtime.viewFor('sess-1');
const anchor = view.segments.find((s) => s.id === 'anchor');
const session = view.segments.find((s) => s.id === 'session');

console.log('anchor  :', JSON.stringify(anchor?.text));
console.log('session :', JSON.stringify(session?.text));
console.log('reports :', JSON.stringify(reports));

const ok = typeof anchor?.text === 'string' && anchor.text.includes('deepseek-v4-flash');
console.log(ok ? 'GREEN: the model reached the bar' : 'RED: the model did not reach the bar');
process.exit(ok ? 0 : 1);
