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
 * A live override counts as something happening. It is the one state that spends
 * money at peak deliberately, and `bubbleContentFor` writes text for it, so
 * suppressing it here would make the badge silent about the most expensive thing
 * it knows.
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
  return state.engaged === true || state.phase === 'armed' || state.overrideActive === true;
}

/**
 * The schedule's phase names, in the bilingual form the panel uses.
 *
 * Both languages rather than one: "peak" is the word that appears on the pricing
 * page, and the Chinese word is the one the operator reads first.
 */
const PHASE_TEXT = Object.freeze({
  open: ['谷时', 'off-peak'],
  armed: ['峰前', 'pre-peak'],
  peak: ['峰时', 'peak'],
  releasing: ['放行中', 'releasing'],
});

/** Why dispatch is held, in words rather than in the state's own vocabulary. */
const REASON_TEXT = Object.freeze({
  peak: '峰时计费',
  'pre-peak-brace': '峰前提前量',
  'post-peak-brace': '峰后提前量',
});

/** Why the last release happened. */
const RELEASE_TEXT = Object.freeze({ schedule: '谷时到达', override: '手动覆盖' });

/** What the schedule will do next, named for the operator. */
const EDGE_TEXT = Object.freeze({ arm: '峰前', peak: '峰时', release: '谷时' });

/**
 * Format an instant as a local date and time, which is what the panel shows.
 *
 * Seconds are dropped deliberately: this is read at a glance, and a value that
 * changes every second reads as a countdown that is not one.
 *
 * @param {number} epochMs - the instant.
 * @returns {string} `YYYY-MM-DD HH:MM`, or an empty string for a non-finite input.
 */
export function formatStamp(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${day} ${formatClock(epochMs)}`;
}

/**
 * Compose the info panel that sits above the character.
 *
 * A small dashboard rather than a sentence, which is the design: a titled header, a
 * hairline, then six label/value rows. The rows are the questions an operator
 * actually has — what tariff am I on, is it holding anything, when does that change,
 * and did I override it — and every one is answered from the published state.
 *
 * Returns `undefined` only when there is no state at all. An ordinary idle state
 * still produces a panel: "nothing is wrong" is worth being able to read, and the
 * caller decides whether to show it.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {number} nowMs - the current instant.
 * @param {object} [labels] - localized labels.
 * @returns {{title: string, badge: string|null, rows: {label: string, value: string, tone: string, dot: boolean}[]}|undefined} the panel, or `undefined` when there is nothing to describe.
 */
export function panelFor(state, nowMs, labels = {}) {
  if (state === undefined || state === null) return undefined;

  const text = {
    title: labels.panelTitle ?? '调度状态监视',
    live: labels.live ?? 'LIVE',
    phase: labels.rowPhase ?? '当前档位',
    decision: labels.rowDecision ?? '调度决策',
    next: labels.rowNext ?? '下次切换',
    release: labels.rowRelease ?? '放行时刻',
    held: labels.rowHeld ?? '滞留消息',
    override: labels.rowOverride ?? '手动覆盖',
    none: labels.none ?? '无',
    count: labels.count ?? '条',
  };

  const [phaseChinese, phaseEnglish] = PHASE_TEXT[state.phase] ?? PHASE_TEXT.open;
  const engaged = state.engaged === true;
  const override = state.overrideActive === true;

  const edgeLabel = EDGE_TEXT[state.nextTransitionEdge] ?? state.nextTransitionEdge ?? '';
  const nextValue =
    typeof state.nextTransitionMs === 'number'
      ? `${edgeLabel}，${formatStamp(state.nextTransitionMs)}`
      : text.none;

  return {
    title: text.title,
    badge: text.live,
    rows: [
      // The one row that carries a mark, and the design draws it in the *phase*
      // colour while the value beside it stays brand blue — so off-peak reads as the
      // good cheap state rather than as an absence of activity.
      {
        label: text.phase,
        value: `${phaseChinese} (${phaseEnglish})`,
        tone: 'accent',
        dotColour: PHASE_ACCENTS[state.phase] ?? PHASE_ACCENTS.open,
      },
      {
        label: text.decision,
        value: engaged ? `拦截 —— ${REASON_TEXT[state.reason] ?? state.reason}` : `放行 —— ${phaseEnglish}`,
        tone: engaged ? 'accent' : 'normal',
        dotColour: null,
      },
      { label: text.next, value: nextValue, tone: 'normal', dotColour: null },
      {
        label: text.release,
        value:
          typeof state.releaseAtMs === 'number'
            ? formatStamp(state.releaseAtMs)
            : typeof state.lastReleaseAtMs === 'number' && state.lastReleaseReason !== null
              ? `${RELEASE_TEXT[state.lastReleaseReason] ?? state.lastReleaseReason}，${formatStamp(state.lastReleaseAtMs)}`
              : text.none,
        tone: 'normal',
        dotColour: null,
      },
      {
        label: text.held,
        value: engaged ? `${state.heldCount} ${text.count}` : '0',
        tone: engaged ? 'accent' : 'normal',
        dotColour: null,
      },
      {
        label: text.override,
        value:
          override && typeof state.overrideUntilMs === 'number'
            ? `${labels.override ?? '已按峰价放行'}，${formatStamp(state.overrideUntilMs)}`
            : text.none,
        tone: override ? 'danger' : 'muted',
        dotColour: null,
      },
    ],
  };
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
 * The colour the panel's tariff row marks the phase with.
 *
 * A different axis from the bead, and the design draws both: the bead describes what
 * the *badge* is doing — deliberately grey when that is nothing — while this
 * describes the *tariff*, where off-peak is the good cheap state and earns a green
 * mark. Reusing the bead's grey here would have made "cheap" and "nothing happening"
 * look identical, and the design's own panel shows the off-peak mark in green.
 */
export const PHASE_ACCENTS = Object.freeze({
  open: '#34c759',
  armed: '#ff9500',
  peak: '#007aff',
  releasing: '#007aff',
});

/**
 * The status bead: one row of the design's physical spec per state.
 *
 * A bead is four layers — a blurred halo, a translucent shell, a bright core and a
 * pinprick of white glare — and the *halo's radius* is what carries intensity. That
 * is the design's whole idea: the colour says which state, the glow says how much
 * the state matters, so quiet costs nothing and the one state that actually spends
 * money is the only one that shouts.
 *
 * These are the design's literals rather than theme tokens, deliberately. They are
 * standard system status colours, chosen to read identically in either theme, and a
 * status colour that shifted with the theme would stop being a signal. The panels
 * still take their surfaces from the theme; only the bead is fixed.
 */
export const BADGE_ACCENTS = Object.freeze({
  idle: Object.freeze({ shell: '#8e9aa8', core: '#7e8b9b', glow: 22 }),
  armed: Object.freeze({ shell: '#ff9500', core: '#ffe066', glow: 28 }),  held: Object.freeze({ shell: '#007aff', core: '#70c2ff', glow: 30 }),
  released: Object.freeze({ shell: '#34c759', core: '#96f5b4', glow: 28 }),
  override: Object.freeze({ shell: '#ff3b30', core: '#ff9e96', glow: 36 }),
});

/**
 * The bead for a published state.
 *
 * Derived from the same pose decision the character takes, so the bead, the panel's
 * accent row and the art can never describe three different instants.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {number} [nowMs] - the current instant, for the release linger.
 * @returns {{shell: string, core: string, glow: number}} the bead spec.
 */
export function accentFor(state, nowMs = Date.now()) {
  if (state?.overrideActive === true) return BADGE_ACCENTS.override;
  return BADGE_ACCENTS[badgeStateFor(state, nowMs)] ?? BADGE_ACCENTS.idle;
}

/**
 * Describe the buttons the toolbar should offer for a state.
 *
 * Each entry names the action the endpoint accepts and whether it applies now, so
 * a disabled button can say *why* rather than being silently inert. That is the
 * whole reason to disable rather than hide: the toolbar doubles as an explanation
 * of the current state.
 *
 * `tone` carries the visual weight. It is decided here rather than in the renderer
 * because it is a judgement about the operations, not about CSS: reading the state
 * is quiet, releasing once is the bounded and therefore encouraged action, keeping
 * dispatch open spends money until the valley and is deliberately the softer of
 * the two, and dropping an override returns to the policy.
 *
 * @param {object|undefined} state - the published hold state.
 * @param {object} [labels] - localized button labels.
 * @returns {{action: string, label: string, enabled: boolean, hint: string, tone: string, icon: string}[]} the toolbar.
 */
export function toolbarFor(state, labels = {}) {
  const text = {
    status: labels.status ?? '状态',
    now: labels.now ?? '放行一次',
    window: labels.window ?? '放行到谷',
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
    { action: 'status', label: text.status, enabled: true, hint: '', tone: 'ghost', icon: 'info' },
    {
      action: 'now',
      label: text.now,
      enabled: engaged,
      hint: engaged ? '' : text.nothingHeld,
      tone: 'primary',
      icon: 'play',
    },
    {
      action: 'window',
      label: text.window,
      enabled: peakish && !overridden,
      hint: peakish ? (overridden ? text.noOverride : text.costsPeak) : text.peakOnly,
      tone: 'outline',
      icon: 'arrow-down',
    },
    {
      action: 'cancel',
      label: text.cancel,
      enabled: overridden,
      hint: overridden ? '' : text.noOverride,
      tone: 'outline',
      icon: 'rotate-ccw',
    },
  ];
}
