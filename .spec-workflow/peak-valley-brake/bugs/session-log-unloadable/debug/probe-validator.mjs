/**
 * [pvb-repro] Verify the recovery hypothesis against the harness's own validator.
 *
 * Uses the shipped `validateStoredEvents` — the exact function that refuses to
 * load the session — so the verdict is the real behaviour, not a reimplementation.
 *
 * Hypothesis: adding `ignorable: true` to the offending envelopes makes the same
 * log loadable, and the event's `data` survives.
 */
const MODULE = 'file:///D:/SoftWare/DSH/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js';

const { validateStoredEvents } = await import(MODULE);

/** The real envelopes read out of the damaged log, seq 9064 and 9070. */
const real = [
  {
    type: 'peak-valley-brake/change',
    seq: 9064,
    time: 1789539038410,
    data: {
      engaged: true,
      phase: 'peak',
      heldCount: 1,
      reason: 'peak',
      releaseAtMs: 1789552860000,
      lastReleaseReason: null,
      lastReleaseAtMs: null,
      nextTransitionMs: 1789552800000,
      nextTransitionEdge: 'peak-end',
      overrideActive: false,
      overrideUntilMs: null,
      updatedAtMs: 1789539037993,
    },
  },
];

const meta = { id: 'session-probe', version: 3, createdAt: 1 };

const asWritten = structuredClone(real);
try {
  validateStoredEvents(meta, asWritten, undefined);
  console.log('AS WRITTEN      : LOADED (unexpected)');
} catch (error) {
  console.log(`AS WRITTEN      : REFUSED -> ${error.constructor.name}`);
  console.log(`                  ${error.message}`);
}

const repaired = structuredClone(real);
for (const event of repaired) event.ignorable = true;
try {
  const out = validateStoredEvents(meta, repaired, undefined);
  const survivor = out.find((event) => event.type === 'peak-valley-brake/change');
  console.log('WITH ignorable  : LOADED');
  console.log(`                  derived type kept: ${survivor?.type}`);
  console.log(`                  ignorable flag    : ${String(survivor?.ignorable)}`);
  console.log(`                  data intact       : ${String(survivor?.data?.phase === 'peak' && survivor?.data?.heldCount === 1)}`);
  console.log(`                  frozen            : ${String(Object.isFrozen(survivor))}`);
} catch (error) {
  console.log(`WITH ignorable  : REFUSED -> ${error.constructor.name}: ${error.message}`);
}
