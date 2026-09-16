# Diagnosis: the info bar reads `未选择模型` while a model is in use

## Symptom

The info bar rendered `DeepSeek · 未选择模型` in the anchor segment. The other five
segments were correct (`空闲价`, `距高峰 12:15:49`, `余额 ¥510.750`, `本会话 ¥0.219`,
`高峰 ¥0.000 · 空闲 ¥0.219`), and the session had non-zero spend — so calls were being
made, priced, and recorded while the model name was blank.

## Confirmed root cause

Two independent defects, each of which could mask the other. **Neither alone produces the
symptom**, which is why it survived review and a green suite.

1. **A guessed accessor.** `lib/index.js` read `agent?.session?.model ?? agent?.model`.
   Neither property exists. The harness reads the model as `agent.options.model` — see
   `dsh-compaction-basic/lib/index.js:726` in the DSH checkout. The lookup therefore
   missed on **every** call and returned `''`.

2. **`??` does not fall through on `''`.** In `lib/usage-runtime.js`:

   ```js
   options.modelFor?.(sessionId) ?? lastModel   // '' ?? lastModel  ->  ''
   ```

   `''` is a *value* to `??`, so a resolver that meant "I don't know" silently discarded a
   model the runtime had already observed. Proof that the value was present: the ledger
   recorded `costCny: 0.0036` with `unpricedCalls: 0`, which is only reachable if
   `record.model` carried the model name.

A third, lesser defect surfaced during diagnosis: the model was only remembered inside
`record()`, i.e. when a usage chunk arrived, so the bar stayed blank for the whole of the
first response. It is now remembered when the call is *initiated*, since
`GenerateOptions.model` is required and known from the moment the request goes out.

## Repro loop

```sh
node .spec-workflow/usage-info-bar/bugs/model-name-blank/debug/repro.mjs
```

Red before the fix (exit 1):

```
anchor  : "DeepSeek · 未选择模型"
RED: the model did not reach the bar
```

Green after (exit 0): `anchor : "DeepSeek · deepseek-v4-flash"`.

Minimisation: the harness was cut until every remaining element was load-bearing. Session
attribution (`sess-1 · ¥0.004`), pricing, and the ledger were all verified working, which
isolated the failure to the model path alone.

## Fix

- `lib/usage-collect.js` — added `modelFromAgent(agent)`, reading `agent.options.model`, so
  the accessor has one home and one test.
- `lib/index.js` — `modelFor` now delegates to `modelFromAgent`.
- `lib/usage-runtime.js` — added `firstNonEmpty(...)`, which defaults on *emptiness* rather
  than nullishness; the model is remembered at call initiation, per session and globally;
  `viewFor` resolves `live selection → this session's last call → last call anywhere`.
  `??` must not be used to default a model name anywhere on this path.

## Regression tests

`test/usage-model.test.mjs` (7 assertions), split so that either half regressing alone
turns something red:

- R1/R2 — the runtime must not discard an observed model when the lookup misses.
- R3/R4 — a resolving lookup wins; the placeholder means genuinely unknown.
- A1–A3 — the accessor reads `options.model` and tolerates absent/non-string values.

R1 and R2 were watched failing with the exact user-visible string before the fix.

## A second, larger defect found while validating

`package.json`'s `test` script was a hand-written chain of file names, and it had fallen
**four files behind**: `usage-ledger`, `usage-collect`, `info-bar-view`, and `info-bar-slot`
never ran under `npm test`. The info-bar feature shipped with tests that the default command
did not execute. A green `npm test` therefore claimed coverage it did not have.

Fixed structurally: `scripts/run-tests.mjs` discovers `test/*.test.mjs` by suffix, so a new
test file is in the suite the moment it is created and there is no list to forget.
`test/suite.test.mjs` (4 assertions) pins the shape of the command — it fails if anyone
reintroduces a name list. Both guards were verified non-vacuous by feeding them the exact
input they exist to reject.

## Validation

```sh
npm test     # 19 files run, 0 failed — 470 assertions
```

Files are now discovered, so this count is the whole suite rather than a subset.

## Files changed

`lib/usage-collect.js`, `lib/index.js`, `lib/usage-runtime.js`, `package.json`,
`test/usage-model.test.mjs` (new), `test/suite.test.mjs` (new), `scripts/run-tests.mjs` (new).

## Cleanup

No `[DEBUG-...]` instrumentation was added. The two throwaway harnesses are kept under this
bug's `debug/` directory and are documented as disposable; neither is part of `npm test`.

## Remaining risk

The model name is remembered in memory only, so after a restart the bar shows the
placeholder until either a call is made or the agent lookup resolves. The lookup path is now
correct, but it has not been exercised against a live agent from this session — only against
fixtures copied from the harness source. Worth a glance after restart.

## Architecture follow-up

The two halves of this defect lived in different modules with no shared seam: the resolver in
`lib/index.js` and the fallback in `lib/usage-runtime.js`. A test of either alone stays green
while the pair is broken. `modelFromAgent` now gives the accessor a single testable home,
which is the cheapest available reduction of that gap; a fuller fix would have the runtime
own the resolver outright rather than receiving it as a callback.
