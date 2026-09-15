/**
 * Badge presentation logic: which character to show and what the bubble says.
 *
 * Kept free of the DOM so it can be tested in Node. The badge's appearance is the
 * one part of this project that cannot be verified here — there is no browser in
 * the test suite — so everything upstream of "put this image at this position"
 * is pure and asserted, leaving only the visual arrangement unverified.
 *
 * @module peak-valley-brake/badge-view
 */

/** The four character states, each of which must have art. */
export const BADGE_STATES = Object.freeze(['idle', 'armed', 'held', 'released']);

/** How long the delivered pose lingers after a release, in milliseconds. */
export const RELEASED_LINGER_MS = 4_000;

/**
 * Choose the character state for a published hold state.
 *
 * Priority, highest first:
 *   1. `held`     — work is being withheld; this is the state the badge exists for.
 *   2. `released` — a release just happened, and the delivery pose is the point.
 *   3. `armed`    — the pre-peak brace; a warning that costs nothing to show.
 *   4. `idle`     — everything else.
 *
 * `held` outranks `released` because the two are not symmetrical: `engaged` is
 * authoritative for the present moment, while `lastReleaseAtMs` only records when
 * the last release happened and stays set afterwards. Work held again inside the
 * linger window must not be shown as delivered — that would be the badge lying
 * about the one thing it exists to report.
 *
 * `released` is time-bounded rather than state-bounded because the published
 * state carries no "just released" flag that could be cleared: a release with no
 * following event would leave the delivery pose showing forever.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {number} nowMs - the current instant.
 * @returns {'idle'|'armed'|'held'|'released'} the character to render.
 */
export function badgeStateFor(state, nowMs) {
  if (state === undefined || state === null) return 'idle';

  if (state.engaged === true) return 'held';

  const releasedAtMs = state.lastReleaseAtMs;
  if (typeof releasedAtMs === 'number' && nowMs - releasedAtMs < RELEASED_LINGER_MS) {
    return 'released';
  }
  if (state.phase === 'armed') return 'armed';
  return 'idle';
}

/**
 * Decide whether the bubble should be visible.
 *
 * The bubble answers "why is nothing happening?", so it appears exactly when
 * something is happening to the work. A manually dismissed bubble stays
 * dismissed until the *situation* changes — a new hold, or a new count — rather
 * than re-appearing on every render, which would make dismissal useless.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {object} preferences - the operator's choices.
 * @param {boolean} [preferences.hidden] - whether the bubble was dismissed.
 * @param {boolean} [preferences.forceShow] - whether the operator pinned it open.
 * @returns {boolean} whether to render the bubble.
 */
export function shouldShowBubble(state, preferences = {}) {
  if (state === undefined || state === null) return false;
  if (preferences.forceShow === true) return true;
  if (preferences.hidden === true) return false;
  return state.engaged === true || state.phase === 'armed';
}

/**
 * Compose the bubble's lines from a published state.
 *
 * Text only: the badge renders it, and keeping the wording here means the bubble
 * and the slash command cannot describe the same state differently by accident.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {number} nowMs - the current instant.
 * @param {object} [labels] - localized labels.
 * @returns {{title: string, detail: string, action: string}|undefined} the bubble content, or `undefined` when there is nothing to say.
 */
export function bubbleContentFor(state, nowMs, labels = {}) {
  const text = {
    held: labels.held ?? '已拦截',
    autoRelease: labels.autoRelease ?? '自动放行',
    armed: labels.armed ?? '即将进入峰时',
    override: labels.override ?? '已按峰价放行',
    cancelHint: labels.cancelHint ?? '/peak-valley cancel 可撤销',
    count: labels.count ?? '条',
    hover: labels.hover ?? '悬停看操作',
  };

  if (state === undefined || state === null) return undefined;

  if (state.engaged === true) {
    return {
      title: `${text.held} ${state.heldCount} ${text.count}`,
      detail:
        typeof state.releaseAtMs === 'number'
          ? `${formatClock(state.releaseAtMs)} ${text.autoRelease}`
          : text.autoRelease,
      action: state.overrideActive === true ? text.cancelHint : text.hover,
    };
  }

  if (state.phase === 'armed') {
    return {
      title: text.armed,
      detail: typeof state.releaseAtMs === 'number' ? formatClock(state.releaseAtMs) : '',
      action: text.hover,
    };
  }

  if (state.overrideActive === true) {
    return {
      title: text.override,
      detail: typeof state.overrideUntilMs === 'number' ? formatClock(state.overrideUntilMs) : '',
      action: text.cancelHint,
    };
  }

  return undefined;
}

/**
 * Format an instant as a local wall clock, which is what an operator reads.
 * @param {number} epochMs - the instant.
 * @returns {string} `HH:MM`, or an empty string for a non-finite input.
 */
export function formatClock(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Clamp a badge position so the whole character stays on screen.
 *
 * A badge dragged to an edge and then rendered on a smaller window would otherwise
 * be partly unreachable, and an unreachable badge cannot be dragged back.
 *
 * @param {{x: number, y: number}} position - desired top-left corner, in pixels from the top-left of the viewport.
 * @param {{width: number, height: number}} badge - the rendered badge size.
 * @param {{width: number, height: number}} viewport - the visible area.
 * @param {number} [margin] - minimum gap kept from each edge.
 * @returns {{x: number, y: number}} a position that keeps the badge fully visible.
 */
export function clampPosition(position, badge, viewport, margin = 8) {
  const maxX = Math.max(margin, viewport.width - badge.width - margin);
  const maxY = Math.max(margin, viewport.height - badge.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}

/**
 * The default resting position: bottom-right, clear of the input box.
 *
 * @param {{width: number, height: number}} badge - the rendered badge size.
 * @param {{width: number, height: number}} viewport - the visible area.
 * @param {number} [inset] - gap from the corner.
 * @returns {{x: number, y: number}} the position.
 */
export function defaultPosition(badge, viewport, inset = 24) {
  return clampPosition(
    { x: viewport.width - badge.width - inset, y: viewport.height - badge.height - inset },
    badge,
    viewport,
  );
}

/**
 * Whether a bubble would overflow the right edge and should open leftwards.
 *
 * @param {{x: number, width: number}} position - badge position and width.
 * @param {number} bubbleWidth - the bubble's width.
 * @param {number} viewportWidth - the visible width.
 * @returns {boolean} whether to anchor the bubble to the badge's left edge.
 */
export function bubbleOpensLeft(position, bubbleWidth, viewportWidth) {
  return position.x + position.width / 2 + bubbleWidth / 2 > viewportWidth;
}

/**
 * Describe the buttons the toolbar should offer for a state.
 *
 * Each entry names the action the endpoint accepts and whether it applies now, so
 * a disabled button can say *why* rather than being silently inert. That is the
 * whole reason to disable rather than hide: the toolbar doubles as an explanation
 * of the current state.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {object} [labels] - localized button labels.
 * @returns {{action: string, label: string, enabled: boolean, hint: string}[]} the toolbar.
 */
export function toolbarFor(state, labels = {}) {
  const text = {
    status: labels.status ?? '状态',
    now: labels.now ?? '放行一次',
    window: labels.window ?? '放行到谷时',
    cancel: labels.cancel ?? '撤销覆盖',
    bubble: labels.bubble ?? '气泡',
    peakOnly: labels.peakOnly ?? '当前不是峰时，无需放行',
    nothingHeld: labels.nothingHeld ?? '当前没有滞留消息',
    noOverride: labels.noOverride ?? '当前没有生效的覆盖',
    costsPeak: labels.costsPeak ?? '会按峰价持续计费',
  };

  const engaged = state?.engaged === true;
  const peakish = state?.phase === 'peak' || state?.phase === 'armed' || state?.phase === 'releasing';
  const overridden = state?.overrideActive === true;

  return [
    { action: 'status', label: text.status, enabled: true, hint: '' },
    {
      action: 'now',
      label: text.now,
      enabled: engaged,
      hint: engaged ? '' : text.nothingHeld,
    },
    {
      action: 'window',
      label: text.window,
      enabled: peakish && !overridden,
      hint: peakish ? (overridden ? text.noOverride : text.costsPeak) : text.peakOnly,
    },
    {
      action: 'cancel',
      label: text.cancel,
      enabled: overridden,
      hint: overridden ? '' : text.noOverride,
    },
  ];
}
