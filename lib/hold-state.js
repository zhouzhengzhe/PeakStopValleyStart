/**
 * The brake's client-facing state: the shape of it, and the rules for advancing it.
 *
 * Why this exists: the hold was only visible in a host log the operator cannot
 * reach, or through a slash command they had to think to run. `agent.inject`
 * looked like the answer and is not — injected content is *pending context*, not
 * a message: a rejected step discards it, and it never enters the session log.
 * So the hold needs state a client can read, which this module defines and the
 * host serves over `POST /api/peak-valley-brake.action`.
 *
 * **This state is deliberately never written to the session log.** It used to be
 * published as a `peak-valley-brake/change` session event folded by a registered
 * projection. That made any session the brake ever held work in permanently
 * unloadable: the harness resolves a stored log against `KNOWN_SESSION_EVENT_TYPES`,
 * a list generated at build time from the harness repository's own
 * `SessionEventMap`, so an out-of-repo plugin's event type is outside it by
 * construction. The documented escape is the envelope's `ignorable: true` marker,
 * and `Session.append()` accepts only `surfaceOp`/`sourceEventSeqs` — so a plugin
 * has no way to set it. Two such records were enough to make the persistence read
 * path refuse a 9244-record session outright, and nothing in the harness consumes
 * the projection anyway (the badge polls the host endpoint), so the write was pure
 * downside. Keep it out: a visibility feature must never be able to cost the
 * operator their history.
 *
 * One property still drives the design: the state is advanced only when the
 * observable state changes. The brake can refuse many steps inside one peak
 * window, and the host re-serves the current state on every poll, so a caller
 * needs to know whether there is anything new to announce.
 *
 * @module peak-valley-brake/hold-state
 */

import { z } from 'zod';

/** The schedule states an operator can see. */
export const PHASES = Object.freeze(['open', 'armed', 'peak', 'releasing']);

/** Why dispatch is currently held, when it is. */
export const HOLD_REASONS = Object.freeze(['peak', 'pre-peak-brace', 'post-peak-brace']);

/**
 * Why the most recent release happened.
 *
 * `schedule` is the ordinary case: the valley arrived. `override` means an
 * operator chose to spend money at peak, which is worth surfacing because it
 * explains a release the schedule did not call for.
 */
export const RELEASE_REASONS = Object.freeze(['schedule', 'override']);

/**
 * The complete published state.
 *
 * Every field is optional-tolerant on decode so an older log stays readable, but
 * the writer always emits all of them.
 */
export const holdStateSchema = z.object({
  /** Whether new work is currently being refused. */
  engaged: z.boolean(),
  /** The schedule classification at the time of writing. */
  phase: z.enum(PHASES),
  /** Messages withheld for this session right now. */
  heldCount: z.number().int().min(0),
  /** Why dispatch is held, or `null` when it is not. */
  reason: z.enum(HOLD_REASONS).nullable(),
  /** When the held work becomes deliverable, or `null` when nothing is held. */
  releaseAtMs: z.number().nullable(),
  /** Why the last release happened, or `null` if none has. */
  lastReleaseReason: z.enum(RELEASE_REASONS).nullable(),
  /**
   * When the last release happened.
   *
   * The badge shows a distinct "delivered" pose for a few seconds after a release.
   * That cannot be derived from `engaged` alone — a release with no following
   * event would leave the pose showing forever — so the instant is published and
   * the badge decides on its own clock. Optional so a record written before this
   * field existed still decodes.
   */
  lastReleaseAtMs: z.number().nullable().optional(),
  /**
   * When the schedule next changes, and what it changes to.
   *
   * The badge's panel shows this, and it has to come from the host: the browser has
   * no window table and no clock the host would agree with. Loosely typed on
   * purpose — a new edge label from the schedule table must reach an older badge
   * rather than fail its decode, because a record that fails to decode leaves the
   * client displaying the previous state indefinitely.
   */
  nextTransitionMs: z.number().nullable().optional(),
  nextTransitionEdge: z.string().nullable().optional(),
  /** Whether a manual override is currently releasing dispatch. */
  overrideActive: z.boolean(),
  /** When that override expires, or `null`. */
  overrideUntilMs: z.number().nullable(),
  /** When this state was written, for a client-side age display. */
  updatedAtMs: z.number(),
});

/** The state a session has before anything has been published. */
export const EMPTY_HOLD_STATE = Object.freeze({
  engaged: false,
  phase: 'open',
  heldCount: 0,
  reason: null,
  releaseAtMs: null,
  lastReleaseReason: null,
  lastReleaseAtMs: null,
  nextTransitionMs: null,
  nextTransitionEdge: null,
  overrideActive: false,
  overrideUntilMs: null,
  updatedAtMs: 0,
});

/**
 * Build the state for a hold.
 *
 * @param {object} input - the facts to publish.
 * @param {string} input.phase - schedule classification.
 * @param {number} input.heldCount - messages withheld.
 * @param {string} input.reason - why dispatch is held.
 * @param {number} input.releaseAtMs - when the work becomes deliverable.
 * @param {object} [input.override] - the live override, when one exists.
 * @param {string} [input.lastReleaseReason] - carried forward from the previous state.
 * @param {number} [input.nowMs] - clock override, for deterministic tests.
 * @returns {object} the complete state to publish.
 */
export function holdStateFor(input) {
  return {
    engaged: true,
    phase: input.phase,
    heldCount: input.heldCount,
    reason: input.reason,
    releaseAtMs: input.releaseAtMs,
    lastReleaseReason: input.lastReleaseReason ?? null,
    lastReleaseAtMs: input.lastReleaseAtMs ?? null,
    nextTransitionMs: input.nextTransitionMs ?? null,
    nextTransitionEdge: input.nextTransitionEdge ?? null,
    overrideActive: input.override !== undefined,
    overrideUntilMs: input.override?.untilMs ?? null,
    updatedAtMs: input.nowMs ?? Date.now(),
  };
}

/**
 * Build the state for a release.
 *
 * @param {object} input - the facts to publish.
 * @param {string} input.phase - schedule classification at release time.
 * @param {string} input.releaseReason - `schedule` or `override`.
 * @param {number} [input.untilMs] - release edge, kept for context; the work is
 *   deliverable now, so `releaseAtMs` reflects that rather than a future edge.
 * @param {object} [input.override] - the override that caused it, when one did.
 * @param {number} [input.nowMs] - clock override, for deterministic tests.
 * @returns {object} the complete state to publish.
 */
export function releaseStateFor(input) {
  const nowMs = input.nowMs ?? Date.now();
  return {
    engaged: false,
    phase: input.phase,
    heldCount: 0,
    reason: null,
    releaseAtMs: null,
    lastReleaseReason: input.releaseReason,
    lastReleaseAtMs: nowMs,
    nextTransitionMs: input.nextTransitionMs ?? null,
    nextTransitionEdge: input.nextTransitionEdge ?? null,
    overrideActive: input.override !== undefined,
    overrideUntilMs: input.override?.untilMs ?? null,
    updatedAtMs: nowMs,
  };
}

/**
 * Compose the state to hand a client right now.
 *
 * `publishedStates` only holds what the brake has already *announced*, and it announces
 * on a step — so a session that has not yet had a message held has no published state at
 * all. A reader that answered from the published record alone returned nothing for it,
 * and a client with nothing to draw shows an empty panel, which is indistinguishable
 * from a broken button.
 *
 * The schedule, though, is always answerable: it is a pure function of the clock and the
 * window table. So the live verdict is laid over whatever was published, and the only
 * parts kept from the published record are the genuinely historical ones — when the last
 * release happened, and why.
 *
 * @param {object|undefined} published - the last state published for the session.
 * @param {object} facts - what the host knows right now.
 * @param {boolean} facts.hold - whether dispatch is currently held.
 * @param {string} facts.reason - why, when it is.
 * @param {string} facts.phase - the schedule classification.
 * @param {number|null} facts.releaseAtMs - when held work becomes deliverable.
 * @param {number} facts.heldCount - messages withheld in this session right now.
 * @param {object|undefined} facts.override - the live override, when one is releasing.
 * @param {number|null} facts.nextTransitionMs - the next schedule change.
 * @param {string|null} facts.nextTransitionEdge - what it changes to.
 * @param {number} facts.nowMs - the instant.
 * @returns {object} a complete state.
 */
export function composeLiveState(published, facts) {
  const base = published ?? EMPTY_HOLD_STATE;
  return {
    ...base,
    engaged: facts.hold === true,
    phase: PHASES.includes(facts.phase) ? facts.phase : base.phase,
    reason: facts.hold === true ? (facts.reason ?? null) : null,
    releaseAtMs: facts.hold === true ? (facts.releaseAtMs ?? null) : null,
    heldCount: facts.hold === true ? Math.max(0, Math.trunc(facts.heldCount ?? 0)) : 0,
    overrideActive: facts.override !== undefined,
    overrideUntilMs: facts.override?.untilMs ?? null,
    nextTransitionMs: facts.nextTransitionMs ?? null,
    nextTransitionEdge: facts.nextTransitionEdge ?? null,
    updatedAtMs: facts.nowMs,
  };
}

/**
 * Whether two published states differ in any way an operator could observe.
 *
 * The timestamp is excluded on purpose: it changes on every build, and treating
 * it as a difference would defeat the whole point of suppressing no-op writes.
 *
 * @param {object|undefined} a - one state.
 * @param {object|undefined} b - the other.
 * @returns {boolean} whether the observable parts differ.
 */
export function holdStateDiffers(a, b) {
  if (a === undefined || b === undefined) return a !== b;
  const observable = [
    'engaged',
    'phase',
    'heldCount',
    'reason',
    'releaseAtMs',
    'lastReleaseReason',
    'nextTransitionMs',
    'nextTransitionEdge',
    'overrideActive',
    'overrideUntilMs',
  ];
  return observable.some((field) => a[field] !== b[field]);
}

/**
 * Advance the published state, unless nothing observable changed.
 *
 * Writes nothing anywhere: the caller caches the returned state and the host
 * serves it. That is the whole point — see the module note on why this state
 * must never enter the session log.
 *
 * @param {object} next - the state to publish.
 * @param {object|undefined} previous - the last state this writer published.
 * @returns {{written: boolean, state: object, reason?: string}} the outcome.
 */
export function nextPublishedState(next, previous) {
  if (!holdStateDiffers(previous, next)) {
    return { written: false, state: previous, reason: 'unchanged' };
  }
  const parsed = holdStateSchema.safeParse(next);
  if (!parsed.success) {
    // A malformed state must not replace a good one: the badge would then be
    // wrong rather than merely stale.
    return { written: false, state: previous, reason: 'invalid' };
  }
  return { written: true, state: parsed.data };
}
