/**
 * The brake's client-facing state: a session event vocabulary and the projection
 * that folds it.
 *
 * Why this exists: the hold was only visible in a host log the operator cannot
 * reach, or through a slash command they had to think to run. `agent.inject`
 * looked like the answer and is not — injected content is *pending context*, not
 * a message: a rejected step discards it, and it never enters the session log.
 * So the hold needs durable state that a client can subscribe to, and in this
 * harness that means a session event plus a projection over it.
 *
 * Two properties drive the design:
 *
 *  - **Events carry the complete state, never a delta.** The projection contract
 *    requires it, and it makes the fold a pure replacement rather than
 *    arithmetic that can drift out of step with the writer.
 *  - **An event is written only when the observable state changes.** The brake
 *    can refuse many steps inside one peak window; writing per refusal would
 *    bury the session log in identical records. So the writer compares the state
 *    it is about to publish with the last one it published, and stays silent when
 *    nothing an operator could see has changed.
 *
 * @module peak-valley-brake/hold-state
 */

import { z } from 'zod';

/**
 * The session event type this plugin owns.
 *
 * A leading namespace keeps it recognisable in a log that also carries
 * framework events, and mirroring `goal/change` matches how the rest of the
 * harness names domain state changes.
 */
export const HOLD_EVENT_TYPE = 'peak-valley-brake/change';

/** The projection registry key. */
export const HOLD_PROJECTION_KEY = 'peakValleyBrake';

/**
 * Bumped when the state fields or the fold semantics change.
 *
 * The registry refuses incompatible versions rather than silently sharing a
 * cell, so this must move whenever a reader could see a different meaning.
 */
export const HOLD_STATE_VERSION = 1;

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
  overrideActive: false,
  overrideUntilMs: null,
  updatedAtMs: 0,
});

/**
 * Fold one event into the published state.
 *
 * Pure and synchronous, as the projection contract requires. Unrelated events
 * must return the *same reference*, which is how the registry skips downstream
 * work — so this returns `state` untouched rather than a copy.
 *
 * @param {object} state - current folded state.
 * @param {{type: string, data?: object}} event - the committed event.
 * @returns {object} the new state, or the same reference when unrelated.
 */
export function applyHoldEvent(state, event) {
  if (event?.type !== HOLD_EVENT_TYPE) return state;
  const decoded = holdStateSchema.safeParse(event.data);
  if (!decoded.success) {
    // A malformed record must not corrupt the view. Keeping the previous state
    // leaves the badge slightly stale, which is far better than wrong.
    return state;
  }
  return decoded.data;
}

/**
 * The projection unit a client subscribes to.
 *
 * `wire.view` shapes what the browser receives. Today it is the state verbatim;
 * it is a separate function so a later client can be given a narrower view
 * without changing the event vocabulary or the version.
 */
export const holdProjectionDefinition = Object.freeze({
  key: HOLD_PROJECTION_KEY,
  stateSchema: holdStateSchema,
  stateVersion: HOLD_STATE_VERSION,
  init: () => EMPTY_HOLD_STATE,
  apply: applyHoldEvent,
  wire: {
    viewSchema: holdStateSchema,
    view: (state) => state,
  },
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
    overrideActive: input.override !== undefined,
    overrideUntilMs: input.override?.untilMs ?? null,
    updatedAtMs: nowMs,
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
    'overrideActive',
    'overrideUntilMs',
  ];
  return observable.some((field) => a[field] !== b[field]);
}

/**
 * Publish one state to a session, unless nothing observable changed.
 *
 * @param {object} session - the session to write to.
 * @param {object} next - the state to publish.
 * @param {object|undefined} previous - the last state this writer published.
 * @returns {{written: boolean, state: object, reason?: string}} the outcome.
 */
export function publishHoldState(session, next, previous) {
  if (!holdStateDiffers(previous, next)) {
    return { written: false, state: previous, reason: 'unchanged' };
  }
  const parsed = holdStateSchema.safeParse(next);
  if (!parsed.success) {
    return { written: false, state: previous, reason: 'invalid' };
  }
  try {
    session.append(HOLD_EVENT_TYPE, parsed.data);
    return { written: true, state: parsed.data };
  } catch (error) {
    // A missing badge is a visibility gap, not a reason to break the brake.
    return { written: false, state: previous, reason: error instanceof Error ? error.message : String(error) };
  }
}
