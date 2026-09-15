/**
 * Self-check for the brake's host integration.
 *
 * Run with `node test/brake.test.mjs`.
 *
 * These tests drive the real `apply()` against a deliberately small fake host:
 * an event emitter that implements the documented Cordis surface this plugin
 * uses (`ctx.on`, agent-scoped `on`, `logger`), plus fake agents that record what
 * the plugin does to them. The fake is small on purpose — the point is to assert
 * this plugin's contract, not to re-implement the harness.
 *
 * The fake reproduces the one host behaviour the whole design pivots on: a
 * rejected step does *not* return its claimed messages to the inbox. If a future
 * host changes that, `the fake host consumes claimed messages on rejection` is
 * the test that documents the assumption.
 *
 * Time is injected: every case fixes `Date.now` so the schedule is deterministic
 * and the suite never depends on when it runs.
 *
 * @module peak-valley-brake/test/brake
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { apply } from '../lib/index.js';

const execFileAsync = promisify(execFile);

const results = { passed: 0, failed: 0 };

/**
 * Run one named async case and record its outcome.
 * @param {string} caseName - the case name.
 * @param {() => Promise<void> | void} body - case body.
 * @returns {Promise<void>} resolution after the case settles.
 */
async function test(caseName, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${caseName}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${caseName}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Install a fixed wall clock for the duration of a case.
 * @param {string} iso - the instant `Date.now()` should report.
 * @returns {() => void} restore function.
 */
function freezeClock(iso) {
  const original = Date.now;
  const fixed = Date.parse(iso);
  Date.now = () => fixed;
  return () => {
    Date.now = original;
  };
}

/**
 * A minimal Cordis-like context: an event registry plus the `logger` surface the
 * brake uses. Handlers are stored per event so a waterfall can be walked.
 * @returns {object} the fake context.
 */
function createContext() {
  const listeners = new Map();
  const warnings = [];
  return {
    warnings,
    listeners,
    /** Register a listener, mirroring `ctx.on`. */
    on(event, handler) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    /** Deliver one event to every registered listener in order. */
    async emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) await handler(payload);
    },
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
    },
  };
}

/**
 * A fake agent that models the loop's claim-then-decide order.
 * @param {string} id - session id.
 * @param {object} [options] - construction options.
 * @param {string} [options.cwd] - workspace directory the session runs in.
 * @returns {object} the fake agent.
 */
function createAgent(id, options = {}) {
  /** Messages parked in the inbox, in order. */
  const inbox = [];
  const ctx = createContext();
  const agent = {
    id,
    ctx,
    session: { header: options.cwd === undefined ? {} : { cwd: options.cwd } },
    inbox: {
      /** Append without waking, mirroring `Inbox.append`. */
      append: (target, message) => {
        assert.equal(target, 'next-turn', 'the brake only appends to the next-turn boundary');
        inbox.push(message);
        void ctx.emit('agent/inbox/inserted', { agent, message });
      },
    },
    /** Messages the brake injected as model-facing context. */
    injected: [],
    /** Deliver model-facing context without waking the driver. */
    inject(message) {
      agent.injected.push(message);
    },
    /** Messages delivered through the waking path. */
    sent: [],
    /**
     * When set, the waking delivery throws instead of delivering.
     *
     * Exists because every other test used a `send` that always succeeds — which
     * is exactly why a real delivery failure reached the operator as "the release
     * command said it was releasing and then nothing happened", with no
     * diagnosable trace anywhere they could look.
     * @type {Error|undefined}
     */
    failSendWith: undefined,
    /** Deliver with a wake, mirroring `Agent.send`. */
    send(message, target, wakeup) {
      assert.equal(target, 'next-turn', 'the brake only sends to the next-turn boundary');
      if (agent.failSendWith !== undefined) throw agent.failSendWith;
      agent.sent.push({ message, wakeup });
      inbox.push(message);
      void ctx.emit('agent/inbox/inserted', { agent, message });
    },
    /** Messages currently parked. */
    get pending() {
      return [...inbox];
    },
    /**
     * Model one step proposal: claim the inbox, ask the brake, honour the answer.
     * @returns {Promise<{kind: string, messages?: object[]}>} the loop's decision.
     */
    async proposeStep() {
      const claimed = inbox.splice(0, inbox.length);
      const handlers = [...(ctx.listeners.get('agent/pre-step') ?? [])];
      let index = -1;
      const dispatch = async () => {
        index += 1;
        const handler = handlers[index];
        if (handler === undefined) return { kind: 'enter', messages: claimed };
        return handler({ agent, messages: claimed, turn: 1, step: 1 }, dispatch);
      };
      const decision = await dispatch();
      // The documented host behaviour this plugin is built around: a rejected
      // step does not return its claimed batch to the inbox.
      if (decision.kind === 'reject') claimed.length = 0;
      return decision;
    },
  };
  return agent;
}

/**
 * A user-role message fixture.
 * @param {string} id - message id.
 * @param {string} text - message text.
 * @returns {object} the message.
 */
function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

const home = await mkdtemp(join(tmpdir(), 'pvb-brake-'));

process.stdout.write('peak-valley-brake host integration\n\n');

await test('off-peak steps enter untouched, byte for byte', async () => {
  const restore = freezeClock('2026-09-15T11:00:00Z'); // Tuesday, off-peak
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-offpeak');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'do the thing'));
    const decision = await agent.proposeStep();
    assert.equal(decision.kind, 'enter');
    assert.equal(decision.messages.length, 1);
    assert.equal(decision.messages[0].id, 'm1');
  } finally {
    restore();
  }
});

await test('a peak step is refused', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z'); // Tuesday, inside the 01:00-04:00 peak
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-peak');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'do the thing'));
    const decision = await agent.proposeStep();
    assert.equal(decision.kind, 'reject');
  } finally {
    restore();
  }
});

await test('a step inside the pre-peak brace is refused', async () => {
  const restore = freezeClock('2026-09-15T00:56:00Z'); // Tuesday, inside the 5-minute brace
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-brace');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'do the thing'));
    assert.equal((await agent.proposeStep()).kind, 'reject');
  } finally {
    restore();
  }
});

await test('a step inside the post-peak release brace is refused', async () => {
  const restore = freezeClock('2026-09-15T04:00:30Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-release-brace');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'do the thing'));
    assert.equal((await agent.proposeStep()).kind, 'reject');
  } finally {
    restore();
  }
});

await test('a refused user message is recorded in the durable ledger', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-ledger');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'ship the parser'));
    await agent.proposeStep();
    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const loaded = await createHoldLedger({ home }).load('session-ledger');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.batch.messages.length, 1);
    assert.equal(loaded.batch.messages[0].summary, 'ship the parser');
    assert.equal(loaded.batch.reason, 'peak');
  } finally {
    restore();
  }
});

await test('the fake host consumes claimed messages on rejection (the assumption under test)', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-assumption');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();
    assert.equal(agent.pending.length, 0, 'a rejected claim is gone from the inbox unless the brake saved it');
  } finally {
    restore();
  }
});

await test('goal-round messages are released rather than held', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-goal');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', { id: 'g1', role: 'user', content: [{ type: 'text', text: 'keep going' }], source: { kind: 'plugin', plugin: 'goal' } });
    await agent.proposeStep();
    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const loaded = await createHoldLedger({ home }).load('session-goal');
    assert.equal(loaded.batch, undefined, 'a regenerable wake must not be held');
  } finally {
    restore();
  }
});

await test('a ledger write failure fails open so the prompt is never lost', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    // Point the ledger under a path whose parent is a regular file, so every
    // write attempt fails while the agent itself is perfectly healthy.
    const blockedParent = join(home, 'blocked');
    await writeFile(blockedParent, 'not a directory', 'utf8');
    const ctx = createContext();
    apply(ctx, { home: join(blockedParent, 'nested'), locale: 'en' });
    const agent = createAgent('session-failopen');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'precious work'));
    const decision = await agent.proposeStep();
    assert.equal(decision.kind, 'enter', 'an unrecordable hold must fail open');
    assert.ok(
      ctx.warnings.some((line) => line.includes('ledger-write-failed')),
      `the degraded path must be reported; warnings were:\n${ctx.warnings.join('\n')}`,
    );
  } finally {
    restore();
  }
});

await test('the disabled switch lets everything through during peak', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en', enabled: false });
    const agent = createAgent('session-disabled');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'enter');
  } finally {
    restore();
  }
});

await test('invalid configuration is refused loudly at load', () => {
  const ctx = createContext();
  assert.throws(() => apply(ctx, { brakeLeadMinutes: -5 }), TypeError);
  assert.throws(() => apply(ctx, { brakeLeadMinutes: 1.5 }), TypeError);
});

process.stdout.write('\nschedule override escape hatch\n');

await test('an override window table replaces the official one', async () => {
  // Declare Tuesday 02:00-03:00 UTC as the only peak, which the official table
  // calls peak anyway, plus a window the official table considers off-peak:
  // Tuesday 12:00-13:00.
  const restore = freezeClock('2026-09-15T12:30:00Z');
  try {
    const ctx = createContext();
    apply(ctx, {
      home,
      locale: 'en',
      peakWindowsOverride: JSON.stringify([
        { weekdays: [2], startMinute: 720, durationMinutes: 60 },
      ]),
    });
    const agent = createAgent('session-override-peak');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'reject', 'the override window must hold');
  } finally {
    restore();
  }
});

await test('the official window stops holding when an override replaces it', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, {
      home,
      locale: 'en',
      // Only Tuesday noon is peak, so 02:00 is off-peak under this table.
      peakWindowsOverride: JSON.stringify([{ weekdays: [2], startMinute: 720, durationMinutes: 60 }]),
    });
    const agent = createAgent('session-override-open');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'enter', 'the override must win over the built-in table');
  } finally {
    restore();
  }
});

await test('a malformed override is refused at load rather than ignored', () => {
  const ctx = createContext();
  assert.throws(() => apply(ctx, { peakWindowsOverride: 'not json' }), TypeError);
  assert.throws(() => apply(ctx, { peakWindowsOverride: '{}' }), TypeError);
  assert.throws(() => apply(ctx, { peakWindowsOverride: '[]' }), TypeError);
  assert.throws(
    () => apply(ctx, { peakWindowsOverride: JSON.stringify([{ weekdays: [9], startMinute: 0, durationMinutes: 60 }]) }),
    TypeError,
  );
  assert.throws(
    () => apply(ctx, { peakWindowsOverride: JSON.stringify([{ weekdays: [1], startMinute: 1439, durationMinutes: 60 }]) }),
    TypeError,
    'a window must not run past the end of its UTC day',
  );
});

await test('an empty override means the official table', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en', peakWindowsOverride: '' });
    const agent = createAgent('session-override-empty');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'reject', 'the official table must still apply');
  } finally {
    restore();
  }
});

await test('the receipt names the release instant it is waiting for', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();
    assert.ok(
      ctx.warnings.some((line) => line.includes('2026-09-15T04:01:00.000Z')),
      `a receipt must name the release instant; warnings were:\n${ctx.warnings.join('\n')}`,
    );
  } finally {
    restore();
  }
});

process.stdout.write('\nrelease and re-delivery\n');

await test('a release re-delivers the withheld prompt in its original order', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-redeliver');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'first'));
    agent.inbox.append('next-turn', userMessage('m2', 'second'));
    const held = await agent.proposeStep();
    assert.equal(held.kind, 'reject');
    assert.equal(agent.pending.length, 0, 'the rejected batch is gone from the inbox');

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z'); // off-peak
    await control.releaseNow();

    const redelivered = agent.pending;
    assert.equal(redelivered.length, 2, 'both messages come back');
    assert.equal(redelivered[0].id, 'm1', 'order is preserved');
    assert.equal(redelivered[1].id, 'm2');
    assert.equal(agent.sent.length, 1, 'exactly one waking delivery');
    assert.equal(agent.sent[0].wakeup, true, 'the waking delivery must actually wake the driver');
    assert.equal(agent.sent[0].message.id, 'm1', 'the first message carries the wake');
  } finally {
    restore();
  }
});

await test('re-delivered work then enters untouched', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-enter-after-release');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'the work'));
    await agent.proposeStep();

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    const decision = await agent.proposeStep();
    assert.equal(decision.kind, 'enter', 'off-peak work must enter');
    assert.equal(decision.messages[0].id, 'm1');
  } finally {
    restore();
  }
});

await test('the ledger is cleared once the batch is delivered', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-cleared');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const loaded = await createHoldLedger({ home }).load('session-cleared');
    assert.deepEqual(loaded, { ok: true, batch: undefined });
  } finally {
    restore();
  }
});

await test('a release pass during peak delivers nothing', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-no-early-release');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();

    await control.releaseNow();
    assert.equal(agent.pending.length, 0, 'a release pass inside peak must not deliver');
  } finally {
    restore();
  }
});

await test('a release pass during the post-peak brace delivers nothing', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-brace-no-release');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();

    restore();
    restore = freezeClock('2026-09-15T04:00:30Z'); // inside the 1-minute release brace
    await control.releaseNow();
    assert.equal(agent.pending.length, 0, 'the release brace must hold past the peak edge');
  } finally {
    restore();
  }
});

await test('a resumed session receives work parked before a restart', async () => {
  // First process lifetime: park the work.
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-across-restart');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'survive the restart'));
    await agent.proposeStep();
  } finally {
    restore();
  }

  // Second process lifetime: a fresh plugin instance resuming off-peak. The
  // verbatim object is gone with the old process, so the reconstruction path
  // must run and must label itself.
  restore = freezeClock('2026-09-15T05:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-across-restart');
    await ctx.emit('agent/created', { agent });
    await ctx.emit('agent/session-start', { agent, source: 'resume' });
    await control.releaseNow();

    assert.equal(agent.pending.length, 1, 'the parked work must come back after a restart');
    assert.match(String(agent.pending[0].content[0].text), /survive the restart/u);
    assert.match(String(agent.pending[0].content[0].text), /could not be restored verbatim/u);
  } finally {
    restore();
  }
});

process.stdout.write('\nmanual override\n');

/**
 * A fake command surface that records registrations.
 * @returns {object} the surface plus its registrations.
 */
function createCommands() {
  const registrations = [];
  return {
    registrations,
    register(definition) {
      const existing = registrations.find((entry) => entry.name === definition.name);
      if (existing !== undefined) throw new Error(`duplicate command ${definition.name}`);
      registrations.push(definition);
    },
  };
}

await test('the command is registered on the host command surface', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    ctx.commands = createCommands();
    apply(ctx, { home, locale: 'en' });
    assert.equal(ctx.commands.registrations.length, 1);
    assert.equal(ctx.commands.registrations[0].name, 'peak-valley');
    assert.match(ctx.commands.registrations[0].description, /override/u);
  } finally {
    restore();
  }
});

await test('a composition with no command surface still arms the brake', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' }); // no ctx.commands
    const agent = createAgent('session-headless');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'reject', 'the brake must work without a command surface');
    assert.ok(typeof control.overrideNow === 'function');
  } finally {
    restore();
  }
});

await test('/peak-valley status reports the phase, the dispatch decision, and the held count', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-status');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();

    const result = await control.runCommand(agent, '');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /schedule: peak/u);
    assert.match(result.text, /dispatch: held — peak/u);
    assert.match(result.text, /held messages here: 1/u);
    assert.match(result.text, /next change: peak-end/u);
    assert.match(result.text, /manual override: none/u);
  } finally {
    restore();
  }
});

await test('`now` releases the held work and reports when the guard re-arms', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-override-once');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'urgent work'));
    await agent.proposeStep();
    assert.equal(agent.pending.length, 0, 'held before the override');

    const result = await control.runCommand(agent, 'now');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /2026-09-15 04:00 UTC/u, 'the re-arm instant must be named in readable form');

    // The command releases on its own; the test must not release a second time.
    await control.releaseNow();
    assert.equal(agent.pending.length, 1, 'the override must release the held prompt exactly once');
    assert.equal(agent.pending[0].id, 'm1');
  } finally {
    restore();
  }
});

await test('a release pass delivers each held message exactly once', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-idempotent-release');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();
    await control.runCommand(agent, 'now');

    // Extra passes must be no-ops: the ledger is cleared by the first successful
    // delivery, which is what makes a duplicated release impossible.
    await control.releaseNow();
    await control.releaseNow();
    assert.equal(agent.pending.length, 1, 'repeated release passes must not duplicate the work');
  } finally {
    restore();
  }
});

await test('a released one-shot override admits the work instead of re-parking it', async () => {
  // Regression guard for the defect a real session hit: the override released
  // the message, the driver claimed it immediately, and the guard — seeing its
  // own override already spent and peak still in force — parked it again in the
  // same instant. The operator saw "releasing now" and then nothing.
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-once-admits');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'urgent work'));
    await agent.proposeStep();
    assert.equal(agent.pending.length, 0, 'held before the override');

    await control.runCommand(agent, 'now');
    assert.equal(control.isOverrideLive(), true, 'the override survives its own release');
    await control.releaseNow();
    assert.equal(agent.pending.length, 1, 'the work is back in the inbox');

    // This is the step that used to re-park it.
    const decision = await agent.proposeStep();
    assert.equal(decision.kind, 'enter', 'the released work must reach the model, not return to the ledger');
    assert.equal(decision.messages[0].content.at(-1).text, 'urgent work');
    assert.equal(control.isOverrideLive(), false, 'admitting the work spends the one-shot override');
    assert.equal(agent.pending.length, 0, 'nothing is left in the inbox');

    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const leftover = await createHoldLedger({ home }).load('session-once-admits');
    assert.deepEqual(leftover, { ok: true, batch: undefined }, 'the ledger must be empty, not re-created');
  } finally {
    restore();
  }
});

await test('the brake re-arms after a one-shot override has been admitted', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-once-rearms');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'released work'));
    await agent.proposeStep();
    await control.runCommand(agent, 'now');
    await control.releaseNow();
    assert.equal((await agent.proposeStep()).kind, 'enter', 'the released work passes');

    // Later work during the same peak must be held again, or `once` was not once.
    agent.inbox.append('next-turn', userMessage('m2', 'later work'));
    assert.equal((await agent.proposeStep()).kind, 'reject', 'the guard must re-arm after the override is spent');
  } finally {
    restore();
  }
});

await test('an unused one-shot override expires at the schedule boundary', async () => {
  // Bounding `once` by the boundary is what keeps "release once" from leaving the
  // brake switched off for good if the operator walks away.
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-once-expiry');
    await ctx.emit('agent/created', { agent });
    await control.runCommand(agent, 'now');
    assert.equal(control.isOverrideLive(), true);

    restore();
    restore = freezeClock('2026-09-15T04:30:00Z'); // past the peak end at 04:00
    assert.equal(control.isOverrideLive(), false, 'an unspent one-shot must not outlive its boundary');
  } finally {
    restore();
  }
});

await test('a one-shot override serves every session in the pass, not only the first', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const first = createAgent('session-multi-a');
    const second = createAgent('session-multi-b');
    await ctx.emit('agent/created', { agent: first });
    await ctx.emit('agent/created', { agent: second });
    first.inbox.append('next-turn', userMessage('m1', 'work a'));
    second.inbox.append('next-turn', userMessage('m2', 'work b'));
    await first.proposeStep();
    await second.proposeStep();

    await control.runCommand(first, 'now');
    await control.releaseNow();
    assert.equal(first.pending.length, 1, 'the asking session must be released');
    assert.equal(second.pending.length, 1, 'a one-shot override must not be consumed by the first delivery');
  } finally {
    restore();
  }
});

await test('a window override keeps dispatch open across turns until the boundary', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-override-window');
    await ctx.emit('agent/created', { agent });

    await control.runCommand(agent, 'window');
    agent.inbox.append('next-turn', userMessage('m1', 'first'));
    assert.equal((await agent.proposeStep()).kind, 'enter', 'first turn dispatches under the window override');
    agent.inbox.append('next-turn', userMessage('m2', 'second'));
    assert.equal((await agent.proposeStep()).kind, 'enter', 'later turns dispatch too');
    assert.equal(control.isOverrideLive(), true);
  } finally {
    restore();
  }
});

await test('a window override expires at the schedule boundary and the brake re-arms', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-window-expiry');
    await ctx.emit('agent/created', { agent });
    // Granted at 02:00, so the boundary is this peak's end at 04:00.
    await control.runCommand(agent, 'window');

    restore();
    restore = freezeClock('2026-09-15T04:30:00Z'); // off-peak: 04:00-06:00 is a valley
    assert.equal(control.isOverrideLive(), false, 'the override must expire at the boundary');
    agent.inbox.append('next-turn', userMessage('m1', 'valley work'));
    assert.equal((await agent.proposeStep()).kind, 'enter', 'the valley dispatches on its own merits');

    // The real test of re-arming is the next peak window at 06:00 UTC.
    restore();
    restore = freezeClock('2026-09-15T06:30:00Z');
    agent.inbox.append('next-turn', userMessage('m2', 'peak work'));
    assert.equal(
      (await agent.proposeStep()).kind,
      'reject',
      'the guard must re-arm by itself in the next peak window',
    );
  } finally {
    restore();
  }
});

await test('`cancel` drops the override and the guard re-arms', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-cancel');
    await ctx.emit('agent/created', { agent });
    await control.runCommand(agent, 'window');
    assert.equal(control.isOverrideLive(), true);

    const result = await control.runCommand(agent, 'cancel');
    assert.equal(result.kind, 'success');
    assert.equal(control.isOverrideLive(), false);
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'reject', 'cancelling must restore the brake');
  } finally {
    restore();
  }
});

await test('`cancel` with nothing active says so instead of pretending', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-cancel-noop');
    await ctx.emit('agent/created', { agent });
    const result = await control.runCommand(agent, 'cancel');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /no manual override was active/u);
  } finally {
    restore();
  }
});

await test('an unknown subcommand is an error and changes nothing', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-bad-subcommand');
    await ctx.emit('agent/created', { agent });
    const result = await control.runCommand(agent, 'please');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /unknown subcommand/u);
    assert.equal(control.isOverrideLive(), false, 'a rejected subcommand must not release anything');
  } finally {
    restore();
  }
});

await test('disabling overrides makes the command refuse rather than obey', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en', allowManualOverride: false });
    const agent = createAgent('session-override-forbidden');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    await agent.proposeStep();

    const result = await control.runCommand(agent, 'now');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /disabled by configuration/u);
    assert.equal(agent.pending.length, 0, 'nothing may be released when the override is forbidden');

    const status = await control.runCommand(agent, 'status');
    assert.match(status.text, /manual override: disabled by configuration/u);
  } finally {
    restore();
  }
});

await test('an override spends real money, so it is recorded in the audit trail', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-audited');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'costly'));
    await agent.proposeStep();

    await control.runCommand(agent, 'now');
    await control.releaseNow();

    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const audit = await createHoldLedger({ home }).readOverrideAudit();
    const record = audit.find((entry) => entry.sessionId === 'session-audited');
    assert.ok(record !== undefined, `the override must be auditable; audit was ${JSON.stringify(audit)}`);
    assert.equal(record.kind, 'once');
    assert.equal(record.grantedBy, 'session-audited');
    assert.equal(record.phaseAtUse, 'peak', 'the audit must record that dispatch happened at peak');
    assert.equal(record.messagesReleased, 1);
    assert.equal(typeof record.atMs, 'number');
  } finally {
    restore();
  }
});

await test('an ordinary off-peak delivery writes no override audit record', async () => {
  const restore = freezeClock('2026-09-15T05:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-no-audit');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'x'));
    assert.equal((await agent.proposeStep()).kind, 'enter');
    await control.releaseNow();

    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const audit = await createHoldLedger({ home }).readOverrideAudit();
    assert.ok(
      !audit.some((entry) => entry.sessionId === 'session-no-audit'),
      'off-peak dispatch is not an override and must not be audited as one',
    );
  } finally {
    restore();
  }
});

process.stdout.write('\nin-conversation receipt\n');

await test('a hold posts one receipt the operator can see in the transcript', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt-visible');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();

    assert.equal(agent.injected.length, 1, 'exactly one receipt, not one per wake');
    const receipt = agent.injected[0];
    assert.equal(receipt.role, 'user', 'context rides a user-role message');
    assert.equal(receipt.source.kind, 'plugin', 'the harness renders plugin sources as context, not operator speech');
    assert.equal(receipt.source.plugin, 'peak-valley-brake');
    assert.equal(receipt.source.form, 'notice', 'a notice is what renders as a collapsed transcript row');
    assert.ok(typeof receipt.source.summary === 'string' && receipt.source.summary.length > 0);
  } finally {
    restore();
  }
});

await test('the receipt names the count withheld and when it returns', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt-content');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'a'));
    agent.inbox.append('next-turn', userMessage('m2', 'b'));
    await agent.proposeStep();

    const text = agent.injected[0].content.map((block) => block.text).join('\n');
    assert.match(text, /2 message\(s\) are withheld/u, 'the count must be truthful');
    assert.match(text, /2026-09-15 04:01/u, 'the operator must learn when the wait ends');
    assert.match(text, /\/peak-valley/u, 'the receipt must say how to release it early');
  } finally {
    restore();
  }
});

await test('the receipt names both release commands, because they differ', async () => {
  // A receipt that mentions only `now` invites the reading "release command =
  // stop withholding", and the operator then finds their very next message
  // withheld again — which reads as the command not working. Both commands have
  // to be visible where the expectation is formed.
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt-commands');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();

    const shown = agent.injected[0].content.map((block) => block.text).join('\n');
    assert.match(shown, /\/peak-valley now/u, 'the one-shot command must be named');
    assert.match(shown, /\/peak-valley window/u, 'the continuous command must be named too');
    assert.match(shown, /next message is withheld again/u, 'the one-shot limit must be stated, not implied');
  } finally {
    restore();
  }
});

await test('the receipt summary stays within the harness bound', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt-bound');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();
    assert.ok(
      agent.injected[0].source.summary.length <= 120,
      'an unbounded summary would be rejected or truncated by the harness',
    );
  } finally {
    restore();
  }
});

await test('a second wake in the same hold does not post a duplicate receipt', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt-once');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'first'));
    await agent.proposeStep();
    agent.inbox.append('next-turn', userMessage('m2', 'second'));
    await agent.proposeStep();

    assert.equal(agent.injected.length, 1, 'a quiet wait must not become a wall of notices');
  } finally {
    restore();
  }
});

await test('announceOnBrake: false keeps the conversation silent', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en', announceOnBrake: false });
    const agent = createAgent('session-receipt-off');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();
    assert.equal(agent.injected.length, 0);
  } finally {
    restore();
  }
});

await test('an off-peak step posts no receipt, because nothing was withheld', async () => {
  const restore = freezeClock('2026-09-15T05:00:00Z');
  try {
    const ctx = createContext();
    apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-receipt-offpeak');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    assert.equal((await agent.proposeStep()).kind, 'enter');
    assert.equal(agent.injected.length, 0);
  } finally {
    restore();
  }
});

process.stdout.write('\nfailed re-delivery is diagnosable\n');

await test('a failed waking delivery keeps the ledger so the work is not lost', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-send-fails');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'precious work'));
    await agent.proposeStep();

    agent.failSendWith = new Error('the harness refused the message');
    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    assert.equal(agent.pending.length, 0, 'nothing was delivered');
    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const stillHeld = await createHoldLedger({ home }).load('session-send-fails');
    assert.equal(stillHeld.ok, true);
    assert.ok(stillHeld.batch !== undefined, 'the ledger must survive a failed delivery, or the work is gone');
    assert.equal(stillHeld.batch.messages.length, 1);
  } finally {
    restore();
  }
});

await test('a failed delivery records the stage, the error, and the message shape', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-delivery-log');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();

    agent.failSendWith = new TypeError('branded id rejected');
    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const records = await createHoldLedger({ home }).readDeliveryOutcomes(50);
    const failure = records.filter((record) => record.sessionId === 'session-delivery-log').at(-1);
    assert.ok(failure !== undefined, 'a delivery attempt must always be recorded');
    assert.equal(failure.outcome, 'failed');
    assert.equal(failure.stage, 'send');
    assert.equal(failure.errorName, 'TypeError');
    assert.match(failure.error, /branded id rejected/u);
    assert.equal(failure.delivered, 0);
    assert.equal(failure.attempted, 1);
    assert.ok(failure.messageShape !== undefined, 'the shape is what answers "was the message well-formed?"');
    assert.ok(Array.isArray(failure.messageShape.keys));
    assert.equal(failure.messageShape.role, 'user');
  } finally {
    restore();
  }
});

await test('a successful delivery is recorded too, so absence is distinguishable', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-delivery-ok');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    const { createHoldLedger } = await import('../lib/hold-ledger.js');
    const records = await createHoldLedger({ home }).readDeliveryOutcomes(50);
    const record = records.filter((entry) => entry.sessionId === 'session-delivery-ok').at(-1);
    assert.ok(record !== undefined, 'a pass that ran must leave a record');
    assert.equal(record.outcome, 'delivered');
    assert.equal(record.delivered, 1);
  } finally {
    restore();
  }
});

await test('/peak-valley status surfaces the last delivery failure', async () => {
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-status-failure');
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();

    agent.failSendWith = new Error('transport said no');
    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    // The failure is visible without reading a log the operator cannot reach.
    const status = await control.runCommand(agent, 'status');
    assert.match(status.text, /FAILED/u);
    assert.match(status.text, /transport said no/u);
    assert.match(status.text, /via send/u);
  } finally {
    restore();
  }
});

await test('status stays quiet about delivery when nothing has failed', async () => {
  const restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en' });
    const agent = createAgent('session-status-clean');
    await ctx.emit('agent/created', { agent });
    const status = await control.runCommand(agent, 'status');
    assert.ok(!/FAILED/u.test(status.text), 'a clean session must not carry a stale failure line');
  } finally {
    restore();
  }
});

await rm(home, { recursive: true, force: true });

process.stdout.write('\nworkspace drift on release\n');

/**
 * Create a temporary git repository that a fake session can run in.
 * @returns {Promise<{dir: string, git: (args: string[]) => Promise<unknown>, cleanup: () => Promise<void>}>} the repository.
 */
async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'pvb-brakedrift-'));
  const git = (args) =>
    execFileAsync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.email=pvb@example.invalid', '-c', 'user.name=pvb', ...args],
      { cwd: dir, timeout: 20_000, windowsHide: true },
    );
  await git(['init', '-q']);
  await writeFile(join(dir, 'tracked.txt'), 'original\n', 'utf8');
  await git(['add', 'tracked.txt']);
  await git(['commit', '-q', '-m', 'initial']);
  return { dir, git, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

await test('work held across an external edit comes back with a re-read notice', async () => {
  const repo = await createRepo();
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en', verifyWorkspaceOnResume: true });
    const agent = createAgent('session-drift', { cwd: repo.dir });
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'edit tracked.txt'));
    await agent.proposeStep();

    // A human edits the file while the request is parked.
    await writeFile(join(repo.dir, 'tracked.txt'), 'edited by a human while you waited\n', 'utf8');

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    assert.equal(agent.pending.length, 1, 'the work must still come back');
    const texts = agent.pending[0].content.map((block) => block.text).join('\n');
    assert.match(texts, /workspace changed while this request was withheld/u, 'the model must be warned');
    assert.match(texts, /tracked\.txt/u, 'the changed file must be named');
    assert.match(texts, /edit tracked\.txt/u, 'the original prompt must survive alongside the notice');
  } finally {
    restore();
    await repo.cleanup();
  }
});

await test('work held across an untouched workspace comes back unannotated', async () => {
  const repo = await createRepo();
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en', verifyWorkspaceOnResume: true });
    const agent = createAgent('session-nodrift', { cwd: repo.dir });
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'edit tracked.txt'));
    await agent.proposeStep();

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    assert.equal(agent.pending.length, 1);
    const texts = agent.pending[0].content.map((block) => block.text).join('\n');
    assert.ok(!/workspace changed/u.test(texts), 'an untouched workspace must not produce a warning');
    assert.equal(agent.pending[0].id, 'm1', 'the message is delivered unchanged, under its own id');
  } finally {
    restore();
    await repo.cleanup();
  }
});

await test('drift never blocks the release', async () => {
  const repo = await createRepo();
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en', verifyWorkspaceOnResume: true });
    const agent = createAgent('session-drift-nonblocking', { cwd: repo.dir });
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();
    await writeFile(join(repo.dir, 'untracked-new.txt'), 'someone added this\n', 'utf8');

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();
    assert.equal(agent.pending.length, 1, 'drift must annotate, never withhold');
  } finally {
    restore();
    await repo.cleanup();
  }
});

await test('a non-repository workspace reports that it could not be checked', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'pvb-plain-'));
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en', verifyWorkspaceOnResume: true });
    const agent = createAgent('session-unverified', { cwd: plain });
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    const texts = agent.pending[0].content.map((block) => block.text).join('\n');
    assert.match(texts, /could not be checked/u);
    assert.match(texts, /not a git repository/u, 'the reason must reach the model in prose, not as a code');
    assert.ok(!/not-a-repository/u.test(texts), 'a machine code must never leak into model-facing text');
    assert.ok(!/workspace changed/u.test(texts), 'an unverifiable workspace must not be reported as changed');
  } finally {
    restore();
    await rm(plain, { recursive: true, force: true });
  }
});

await test('the whole hold-and-release flow speaks Chinese when configured to', async () => {
  const repo = await createRepo();
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'zh', verifyWorkspaceOnResume: true });
    const agent = createAgent('session-chinese', { cwd: repo.dir });
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', '改一下代码'));
    await agent.proposeStep();

    const receipt = agent.injected[0].content.map((block) => block.text).join('\n');
    assert.match(receipt, /处于峰时计价/u, 'the receipt must be Chinese');
    assert.match(receipt, /已拦截 1 条消息/u);
    assert.ok(!/withheld/u.test(receipt), 'no English may leak into the Chinese receipt');

    const status = await control.runCommand(agent, 'status');
    assert.match(status.text, /档位：峰时/u);
    assert.match(status.text, /本会话滞留消息数：1/u);

    await writeFile(join(repo.dir, 'tracked.txt'), 'changed\n', 'utf8');
    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();
    const delivered = agent.pending[0].content.map((block) => block.text).join('\n');
    assert.match(delivered, /工作区发生了变更/u, 'the drift notice must be Chinese too');
    assert.match(delivered, /改一下代码/u, 'the original prompt survives verbatim');
  } finally {
    restore();
    await repo.cleanup();
  }
});

await test('disabling the check produces no drift notice at all', async () => {
  const repo = await createRepo();
  let restore = freezeClock('2026-09-15T02:00:00Z');
  try {
    const ctx = createContext();
    const control = apply(ctx, { home, locale: 'en', verifyWorkspaceOnResume: false });
    const agent = createAgent('session-drift-off', { cwd: repo.dir });
    await ctx.emit('agent/created', { agent });
    agent.inbox.append('next-turn', userMessage('m1', 'work'));
    await agent.proposeStep();
    await writeFile(join(repo.dir, 'tracked.txt'), 'changed\n', 'utf8');

    restore();
    restore = freezeClock('2026-09-15T05:00:00Z');
    await control.releaseNow();

    const texts = agent.pending[0].content.map((block) => block.text).join('\n');
    assert.ok(!/could not be checked|workspace changed/u.test(texts), 'the check is off, so nothing is said');
  } finally {
    restore();
    await repo.cleanup();
  }
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
