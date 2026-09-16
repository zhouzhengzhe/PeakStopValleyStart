/**
 * The info bar as an occupant of the composer dock.
 *
 * The slot is `conversation.composer.dock`, which the harness documents as
 * `replaceRisk: "none"` for a plugin that brings **its own id**: entries with an id of
 * their own are laid *beside* the official row, while reusing the official id `stats`
 * takes that row's place. This plugin therefore registers `peak-valley-info` and leaves
 * `stats` alone — the native statistics row keeps working, and the operator gets both.
 *
 * @see https://github.com/deepseek-ai/deepseek-harness slot catalogue, `conversation.composer.dock`
 *
 * ## Why the countdown ticks locally
 *
 * The figures arrive from one poll every few seconds. A countdown rendered from a poll
 * alone would sit frozen between polls and then jump, which reads as a broken clock.
 * So the *formatting* of one instant runs here, once a second, from the tier-change
 * instant the host supplied. No part of the schedule is reimplemented — the host still
 * decides when the tier changes; the client only counts down to the instant it was given.
 *
 * @module peak-valley-brake/info-bar-slot
 */

import React from 'react';

import { formatCountdown } from './info-bar-view.js';

/** Our own dock id. Never `stats`: that is the official row's id. */
export const INFO_BAR_SLOT_ID = 'peak-valley-info';

/** The official slot the bar occupies. */
export const INFO_BAR_SLOT_NAME = 'conversation.composer.dock';

/**
 * How often the local countdown re-renders, in milliseconds.
 *
 * One second, because the countdown's finest unit is a second. Anything faster would
 * re-render for no visible change.
 */
const TICK_MS = 1000;

/** Colour per tone. Kept here rather than in a stylesheet so the bar cannot lose its meaning. */
const TONE_COLOURS = Object.freeze({
  plain: 'inherit',
  peak: '#e5693f',
  'off-peak': '#2f9e6b',
  muted: 'rgba(128, 128, 128, 0.9)',
  warn: '#c9a227',
});

/**
 * Build the dock component.
 *
 * @param {object} deps - the collaborators.
 * @param {() => object|undefined} deps.readUsage - the latest usage view model, or undefined before the first poll.
 * @param {(listener: () => void) => () => void} deps.subscribe - called after each poll.
 * @param {() => number} [deps.now] - the clock, injected for tests.
 * @returns {Function} the React component the slot renders.
 */
export function createInfoBarComponent(deps) {
  const now = deps.now ?? (() => Date.now());

  return function PeakValleyInfoBar() {
    // The same poll notification the badge uses — one channel, one refresh point.
    const usage = React.useSyncExternalStore(deps.subscribe, deps.readUsage, deps.readUsage);
    const [, setTick] = React.useState(0);

    React.useEffect(() => {
      const handle = setInterval(() => setTick((value) => value + 1), TICK_MS);
      return () => clearInterval(handle);
    }, []);

    if (usage === null || usage === undefined) return null;

    const remaining = Number.isFinite(usage.tierEndsAtMs) ? usage.tierEndsAtMs - now() : Number.POSITIVE_INFINITY;

    return React.createElement(
      'div',
      {
        className: 'pvb-infobar',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '14px',
          padding: '2px 4px',
          fontSize: '12px',
          lineHeight: '1.5',
        },
      },
      ...usage.segments.map((segment) =>
        React.createElement(
          'span',
          {
            key: segment.id,
            title: segment.title,
            style: { color: TONE_COLOURS[segment.tone] ?? 'inherit', whiteSpace: 'nowrap' },
          },
          // The countdown is the one segment the client recomputes, so that it moves
          // between polls. Everything else is rendered exactly as the host decided it.
          segment.id === 'countdown'
            ? `${usage.countdownLabel} ${formatCountdown(remaining)}`
            : segment.text,
        ),
      ),
      ...usage.warnings.map((warning) =>
        React.createElement(
          'span',
          { key: `warn:${warning}`, style: { color: TONE_COLOURS.warn, whiteSpace: 'nowrap' } },
          warning,
        ),
      ),
    );
  };
}

/**
 * Register the info bar in the composer dock.
 *
 * Best-effort in the same way the badge is: a composition without the slots service
 * simply does not get the bar, and nothing else changes. A failure is reported rather
 * than swallowed, because a silently missing bar is indistinguishable from a broken one.
 *
 * @param {object} ctx - the client plugin context.
 * @param {object} deps - the collaborators, as for {@link createInfoBarComponent}.
 * @param {(message: string) => void} [deps.warn] - where to report a failed registration.
 * @returns {boolean} whether the slot was registered.
 */
export function registerInfoBarSlot(ctx, deps) {
  const slots = (() => {
    try {
      return ctx?.slots;
    } catch {
      return undefined;
    }
  })();
  if (slots === undefined || slots === null || typeof slots.register !== 'function') {
    deps.warn?.('no slots service in this composition; the info bar will not appear');
    return false;
  }
  try {
    slots.register(
      {
        name: INFO_BAR_SLOT_NAME,
        id: INFO_BAR_SLOT_ID,
        // After the official row, so the native statistics stay on top and the two lines
        // read as "what the session did" over "what it is costing".
        priority: -1000,
      },
      createInfoBarComponent(deps),
    );
    return true;
  } catch (error) {
    deps.warn?.(`could not register the info bar slot: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
