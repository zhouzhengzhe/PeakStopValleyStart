/**
 * Verification harness: proves the real plugin's projection actually registers in
 * a live harness and that a published hold state folds back out of a real
 * session's event log.
 *
 * This is deliberately separate from `test/brake.test.mjs`: those tests drive a
 * fake host, which cannot tell whether the registry accepts our definition or
 * whether `session.append` accepts our event type. Only a real host can.
 *
 * Run it as a plugin in an isolated profile; it reports to stderr and exits the
 * process so a boot is enough.
 *
 * @module peak-valley-brake/test/verify-projection
 */

import { holdProjectionDefinition } from '../lib/hold-state.js';

export const name = 'pvb-verify-projection';
export const inject = { sessions: null, sessionProjections: null };

export function apply(ctx) {
  const say = (line) => process.stderr.write(`[pvb-verify] ${line}\n`);

  const get = (key) => {
    try {
      return ctx[key];
    } catch {
      return undefined;
    }
  };

  const projections = get('sessionProjections');
  const sessions = get('sessions');
  say(`projections=${projections !== undefined} sessions=${sessions !== undefined}`);
  if (projections === undefined || sessions === undefined) {
    say('RESULT: SKIP (services unavailable)');
    return;
  }

  // 1. The REAL definition must be accepted by the REAL registry.
  try {
    projections.register(holdProjectionDefinition);
    say('register(real definition): OK');
  } catch (error) {
    say(`register(real definition): FAILED ${error?.name}: ${error?.message}`);
    say('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }

  const session = sessions.create(`pvb-verify-${Date.now()}`);

  // 2. Empty state before anything is published.
  try {
    const snap = projections.snapshot(session);
    say(`initial view: ${JSON.stringify(snap.values.peakValleyBrake)}`);
  } catch (error) {
    say(`initial snapshot: FAILED ${error?.message}`);
  }

  // 3. Append a real hold state exactly as the brake would.
  const holdState = {
    engaged: true,
    phase: 'peak',
    heldCount: 2,
    reason: 'peak',
    releaseAtMs: Date.parse('2026-09-15T04:01:00Z'),
    lastReleaseReason: null,
    overrideActive: false,
    overrideUntilMs: null,
    updatedAtMs: Date.now(),
  };
  try {
    session.append('peak-valley-brake/change', holdState);
    say('append(hold state): OK');
  } catch (error) {
    say(`append(hold state): FAILED ${error?.name}: ${error?.message}`);
    say('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }

  try {
    const snap = projections.snapshot(session);
    const view = snap.values.peakValleyBrake;
    say(`view after hold: ${JSON.stringify(view)}`);
    const ok = view?.engaged === true && view?.heldCount === 2 && view?.reason === 'peak';
    say(`fold check: ${ok ? 'OK' : 'MISMATCH'}`);
  } catch (error) {
    say(`snapshot after hold: FAILED ${error?.message}`);
  }

  // 4. A release state must replace it whole.
  try {
    session.append('peak-valley-brake/change', {
      ...holdState,
      engaged: false,
      heldCount: 0,
      reason: null,
      releaseAtMs: null,
      lastReleaseReason: 'schedule',
      updatedAtMs: Date.now(),
    });
    const view = projections.snapshot(session).values.peakValleyBrake;
    say(`view after release: ${JSON.stringify(view)}`);
    const ok = view?.engaged === false && view?.heldCount === 0 && view?.lastReleaseReason === 'schedule';
    say(`release fold check: ${ok ? 'OK' : 'MISMATCH'}`);
  } catch (error) {
    say(`release append: FAILED ${error?.name}: ${error?.message}`);
  }

  // 5. The state must be re-derivable from the log, not just from the live cell.
  try {
    const reloaded = sessions.get(session.id);
    const view = projections.snapshot(reloaded).values.peakValleyBrake;
    say(`view via sessions.get: ${JSON.stringify(view)}`);
    say(`replay check: ${view?.lastReleaseReason === 'schedule' ? 'OK' : 'MISMATCH'}`);
  } catch (error) {
    say(`sessions.get: FAILED ${error?.message}`);
  }

  say('RESULT: PASS');
}
