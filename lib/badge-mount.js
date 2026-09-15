/**
 * The badge, mounted into a document.
 *
 * Written as a function of its dependencies — the art, a way to read the
 * published state, and a way to post an action — so the whole thing can be driven
 * in Node against a minimal fake document. That matters more than usual here:
 * the badge's final appearance cannot be checked by this project, so the behaviour
 * around it is tested as far as it can be, leaving only the pixels to a human.
 *
 * No framework. The client bundle can `require('react')`, but the badge is one
 * image, one bubble and four buttons; reaching for a renderer would add a build
 * step and a class of failure for no benefit.
 *
 * @module peak-valley-brake/badge-mount
 */

import {
  BADGE_STATES,
  badgeStateFor,
  bubbleContentFor,
  bubbleOpensLeft,
  clampPosition,
  defaultPosition,
  shouldShowBubble,
  toolbarFor,
} from './badge-view.js';
import {
  clampHover,
  clampSize,
  DEFAULT_HOVER_MS,
  DEFAULT_SIZE_PX,
  MAX_SIZE_PX,
  MIN_SIZE_PX,
} from './badge-settings.js';

/**
 * The size range, the hover grace period and the clamps all come from
 * `badge-settings.js`, because the settings page offers exactly these knobs.
 * Re-exported here so the mounting module stays the one place a caller has to
 * know about; two copies of a range is how a control and a renderer come to
 * disagree about what is allowed.
 */
export { clampSize, DEFAULT_SIZE_PX, MAX_SIZE_PX, MIN_SIZE_PX };

/**
 * How long the toolbar survives the pointer leaving the badge, by default.
 *
 * The toolbar is positioned outside the character's box, so moving the pointer
 * towards it necessarily crosses a gap that belongs to neither element. Hiding on
 * the first `pointerleave` therefore made the buttons unreachable: the toolbar
 * vanished during the crossing, every time. The grace period also gives a slow or
 * unsteady pointer time to arrive, which is the whole point of a hover menu.
 */
export const HOVER_GRACE_MS = DEFAULT_HOVER_MS;

/** Where the badge remembers its position, size and bubble preference. */
const STORAGE_KEY = 'peak-valley-brake:badge';

/** Gap kept from the viewport edges while dragging. */
const EDGE_MARGIN = 8;

/** Character art is portrait; this is its width-to-height ratio. */
const ASPECT = 4 / 5;

/**
 * The harness theme's tokens, by their real names.
 *
 * Taken from the theme service's own built-in token directory
 * (`dsh-client-ui-theme`, the `BUILTIN_INSPECT_TOKENS` list), which is the only
 * authority on what a plugin may read. The first version invented `--dsw-surface`,
 * `--dsw-text` and friends: none of those exist, so every element silently fell
 * back to its light-mode literal and the badge stayed a white box in a dark theme.
 * An unknown custom property is not an error in CSS — it is simply nothing.
 *
 * The literals are kept, not as a substitute for the theme but for the `file://`
 * deployment where no theme row is mounted at all.
 */
const THEME = Object.freeze({
  /** A floating panel's background. */
  surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
  /** A recessed surface, for controls that are present but unavailable. */
  recessed: 'var(--dsw-alias-bg-layer-2, #f1f3f5)',
  text: 'var(--dsw-alias-label-primary, #1a1a1a)',
  textMuted: 'var(--dsw-alias-label-secondary, #868e96)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
  accent: 'var(--dsw-alias-brand-primary, #2563eb)',
});

/** Element id, so a re-mount replaces rather than duplicates the badge. */
const ROOT_ID = 'peak-valley-brake-badge';

/**
 * Read persisted preferences, tolerating a hostile or empty store.
 *
 * localStorage throws in private modes and when the origin is opaque, so every
 * access is guarded: a badge that cannot remember where it was placed must still
 * appear.
 *
 * These are the *fallback* layer. When the harness settings plane is present its
 * values win, because those are the ones the settings page edits and the ones that
 * roam between machines; this store only has to serve a deployment that has no
 * settings service at all.
 *
 * @param {Storage|undefined} storage - the store, when available.
 * @returns {{position?: {x: number, y: number}, hidden?: boolean, forceShow?: boolean, sizePx?: number, hoverDelayMs?: number}} stored preferences.
 */
export function readPreferences(storage) {
  if (storage === undefined || storage === null) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const position =
      parsed.position !== null &&
      typeof parsed?.position === 'object' &&
      Number.isFinite(parsed.position.x) &&
      Number.isFinite(parsed.position.y)
        ? { x: parsed.position.x, y: parsed.position.y }
        : undefined;
    const sizePx = clampSize(parsed.sizePx);
    const hoverDelayMs = clampHover(parsed.hoverDelayMs);
    // `hidden` and `forceShow` are the names `shouldShowBubble` reads; keeping one
    // vocabulary across the two modules is what stops a dismissal from being
    // written under a key nothing consults.
    return {
      ...(position === undefined ? {} : { position }),
      ...(parsed.hidden === true ? { hidden: true } : {}),
      ...(parsed.forceShow === true ? { forceShow: true } : {}),
      ...(sizePx === undefined ? {} : { sizePx }),
      ...(hoverDelayMs === undefined ? {} : { hoverDelayMs }),
    };
  } catch {
    return {};
  }
}

/**
 * Persist preferences, ignoring a store that refuses to accept them.
 * @param {Storage|undefined} storage - the store, when available.
 * @param {object} preferences - what to remember.
 * @returns {void}
 */
export function writePreferences(storage, preferences) {
  if (storage === undefined || storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* a full or forbidden store must not break the badge */
  }
}

/**
 * Mount the badge.
 *
 * @param {object} options - mounting options.
 * @param {Document} options.document - the document to mount into.
 * @param {Window} [options.window] - the window, for viewport size and listeners.
 * @param {Storage} [options.storage] - preference store.
 * @param {Record<string, string>} options.art - character art keyed by state.
 * @param {() => (object|undefined)} options.readState - read the last published hold state.
 * @param {(action: string) => Promise<object|undefined>} options.postAction - post a toolbar action.
 * @param {object} [options.labels] - localized text.
 * @param {(listener: () => void) => () => void} [options.subscribe] - subscribe to published-state changes.
 * @param {number} [options.hoverGraceMs] - how long the toolbar survives the pointer leaving it.
 * @param {number} [options.sizePx] - initial rendered height, when no stored preference exists.
 * @returns {{dispose: () => void, refresh: () => void, setSize: (px: number, behaviour?: object) => number, showNotice: (text: string, ms?: number) => void, readonly state: object|undefined}} teardown, manual refresh, resize, and one-off text.
 */
export function mountBadge(options) {
  const doc = options.document;
  const view = options.window;
  const art = options.art;
  const labels = options.labels ?? {};
  const preferences = readPreferences(options.storage);
  // An explicit option wins over the stored preference only when nothing was ever
  // stored: otherwise reopening the page would undo the operator's own choice.
  if (preferences.sizePx === undefined && clampSize(options.sizePx) !== undefined) {
    preferences.sizePx = clampSize(options.sizePx);
  }

  doc.getElementById?.(ROOT_ID)?.remove();

  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-state', 'idle');
  Object.assign(root.style, {
    position: 'fixed',
    zIndex: '2147483000',
    userSelect: 'none',
    cursor: 'grab',
    touchAction: 'none',
    filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.28))',
    transition: 'opacity 200ms ease',
  });

  const image = doc.createElement('img');
  image.alt = labels.alt ?? 'Peak/valley brake status';
  image.draggable = false;
  Object.assign(image.style, {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
    transition: 'opacity 200ms ease',
  });
  root.appendChild(image);

  const bubble = doc.createElement('div');
  Object.assign(bubble.style, {
    position: 'fixed',
    minWidth: '150px',
    maxWidth: '260px',
    padding: '8px 10px',
    borderRadius: '10px',
    background: THEME.surface,
    color: THEME.text,
    border: `1px solid ${THEME.border}`,
    boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
    fontSize: '12px',
    lineHeight: '1.5',
    display: 'none',
  });
  doc.body.appendChild(root);
  doc.body.appendChild(bubble);

  const toolbar = doc.createElement('div');
  Object.assign(toolbar.style, {
    position: 'fixed',
    display: 'none',
    gap: '4px',
    padding: '4px',
    borderRadius: '10px',
    background: THEME.surface,
    border: `1px solid ${THEME.border}`,
    boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
    fontSize: '12px',
  });
  doc.body.appendChild(toolbar);

  let current = { ...preferences };
  let lastState;
  let disposed = false;
  /**
   * Text a command just returned, shown in place of the ordinary bubble.
   *
   * The buttons run the same handlers as the `/peak-valley` subcommands, and those
   * answer with words — a status report, a refusal, a confirmation. Dropping that
   * answer would make the button and the command line behave differently, which is
   * exactly what routing both through one handler exists to prevent.
   *
   * @type {{text: string, untilMs: number}|undefined}
   */
  let notice;

  /** Size of the viewport, with a fallback so a headless document still works. */
  const viewport = () => ({
    width: view?.innerWidth ?? 1200,
    height: view?.innerHeight ?? 800,
  });

  /** The rendered height the operator asked for, clamped to what the art supports. */
  const sizePx = () => clampSize(current.sizePx) ?? DEFAULT_SIZE_PX;

  /** The character's box, read from the element so a stylesheet cannot disagree. */
  const badgeSize = () => {
    const height = sizePx();
    return { width: root.offsetWidth || Math.round(height * ASPECT), height };
  };

  /** Apply the size to the element; called on mount and whenever it changes. */
  const applySize = () => {
    const height = sizePx();
    root.style.width = `${Math.round(height * ASPECT)}px`;
    root.style.height = `${height}px`;
  };

  /** Place the character, clamped to the visible area. */
  const place = () => {
    const size = badgeSize();
    const position =
      current.position ?? defaultPosition(size, viewport(), 24);
    const clamped = clampPosition(position, size, viewport(), EDGE_MARGIN);
    current.position = clamped;
    root.style.left = `${clamped.x}px`;
    root.style.top = `${clamped.y}px`;
    // The toolbar goes first and reports where it landed, because the bubble has
    // to clear it: both want the space above the character, and during a hold they
    // are on screen together as soon as the pointer arrives.
    placeBubble(clamped, size, placeToolbar(clamped, size));
  };

  /**
   * Put the bubble above the character, flipping sideways when it would overflow.
   *
   * @param {{x: number, y: number}} position - the character's clamped position.
   * @param {{width: number, height: number}} size - the character's rendered size.
   * @param {boolean} [toolbarAbove] - whether the toolbar took the space directly above.
   * @returns {void}
   */
  const placeBubble = (position, size, toolbarAbove = false) => {
    const width = bubble.offsetWidth || 180;
    const height = bubble.offsetHeight || 60;
    const opensLeft = bubbleOpensLeft({ x: position.x, width: size.width }, width, viewport().width);
    bubble.style.left = `${opensLeft ? Math.max(EDGE_MARGIN, position.x + size.width - width) : position.x}px`;
    // Stacked above the toolbar when the toolbar is there, rather than on top of it.
    const lift = toolbarAbove ? (toolbar.offsetHeight || 34) + 6 : 0;
    bubble.style.top = `${Math.max(EDGE_MARGIN, position.y - height - 6 - lift)}px`;
  };

  /**
   * Put the toolbar beside the character, on whichever side has room.
   *
   * @param {{x: number, y: number}} position - the character's clamped position.
   * @param {{width: number, height: number}} size - the character's rendered size.
   * @returns {boolean} whether it was placed above the character.
   */
  const placeToolbar = (position, size) => {
    const width = toolbar.offsetWidth || 240;
    const height = toolbar.offsetHeight || 34;
    const opensLeft = bubbleOpensLeft({ x: position.x, width: size.width }, width, viewport().width);
    toolbar.style.left = `${opensLeft ? Math.max(EDGE_MARGIN, position.x + size.width - width) : position.x}px`;
    // Below by preference, above when the viewport has no room — the same rule the
    // bubble follows. Clamping to a fixed offset from the bottom instead put the
    // toolbar on top of the character at the badge's default resting place: the
    // clamp sat 16px higher than the badge's own bottom edge, so the character's
    // feet were covered until the badge was dragged upwards.
    const below = position.y + size.height + 6;
    const above = position.y - height - 6;
    const fitsBelow = below + height <= viewport().height - EDGE_MARGIN;
    toolbar.style.top = `${fitsBelow ? below : Math.max(EDGE_MARGIN, above)}px`;
    return !fitsBelow;
  };

  /** Apply one published state to the DOM. */
  const render = () => {
    if (disposed) return;
    const state = options.readState();
    lastState = state;

    const characterState = chooseCharacter(state);
    if (art[characterState] !== undefined) {
      const next = art[characterState];
      if (image.src !== next) {
        // Cross-fade rather than swap abruptly: a character that pops between
        // poses reads as a glitch.
        image.style.opacity = '0';
        image.src = next;
        image.style.opacity = '1';
      }
    }
    root.setAttribute('data-state', characterState);

    renderBubble(state);
    renderToolbar(state);
    place();
  };

  /**
   * Fill the bubble: a command's answer when there is a fresh one, otherwise the
   * state's own summary.
   *
   * @param {object|undefined} state - the published state.
   * @returns {void}
   */
  const renderBubble = (state) => {
    const fresh = notice !== undefined && notice.untilMs > Date.now();
    if (fresh) {
      // An answer to something the operator just clicked is shown even when the
      // status bubble was dismissed: dismissal hides standing information, not a
      // reply.
      showBubbleLines(notice.text.split('\n'));
      return;
    }
    notice = undefined;
    const content = bubbleContentFor(state, Date.now(), labels);
    if (content === undefined || !shouldShowBubble(state, current)) {
      bubble.style.display = 'none';
      return;
    }
    showBubbleLines([content.title, content.detail, content.action]);
  };

  /**
   * Render bubble lines, dropping the empty ones.
   * @param {string[]} lines - candidate lines.
   * @returns {void}
   */
  const showBubbleLines = (lines) => {
    bubble.textContent = '';
    for (const line of lines.filter((value) => value !== undefined && value !== '')) {
      const row = doc.createElement('div');
      row.textContent = line;
      bubble.appendChild(row);
    }
    bubble.style.display = 'block';
  };

  /** Decide the character, tolerating a state the art does not cover. */
  const chooseCharacter = (state) => {
    const chosen = badgeStateFor(state, Date.now());
    return BADGE_STATES.includes(chosen) && art[chosen] !== undefined ? chosen : 'idle';
  };

  /** Rebuild the toolbar for the current state. */
  const renderToolbar = (state) => {
    toolbar.textContent = '';
    for (const button of toolbarFor(state, labels)) {
      const element = doc.createElement('button');
      element.type = 'button';
      element.textContent = button.label;
      element.disabled = !button.enabled;
      if (button.hint !== '') element.title = button.hint;
      Object.assign(element.style, {
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid transparent',
        background: button.enabled ? THEME.accent : THEME.recessed,
        color: button.enabled ? '#ffffff' : THEME.textMuted,
        cursor: button.enabled ? 'pointer' : 'not-allowed',
        fontSize: '12px',
      });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        void act(button.action);
      });
      toolbar.appendChild(element);
    }
  };

  /** Post one toolbar action, then re-read the state. */
  const act = async (action) => {
    try {
      await options.postAction(action);
    } catch {
      /* the badge reports through the bubble, not by throwing into the page */
    }
    render();
  };

  /** Show or hide the toolbar. */
  const setToolbarVisible = (visible) => {
    toolbar.style.display = visible ? 'flex' : 'none';
    if (visible) place();
  };

  /**
   * Hide the toolbar, but not the instant the pointer leaves.
   *
   * The toolbar sits outside the character's box — beside it, or above it when the
   * viewport has no room below — so travelling from the character to a button
   * always crosses a strip that belongs to neither element. Hiding on the first
   * `pointerleave` made the buttons impossible to press: the toolbar disappeared
   * mid-crossing, every time, which is exactly what a hover menu must not do.
   *
   * The delay is short enough to feel immediate and long enough to cross a few
   * pixels of gap or to recover a shaky pointer, and arriving on the toolbar
   * cancels it outright.
   */
  let hideTimer;
  /**
   * The grace period in force right now.
   *
   * A stored preference wins over the mount option so a page reload keeps the
   * operator's choice; the settings plane overrides both by calling
   * `setHoverGrace`.
   */
  const hoverGrace = () =>
    clampHover(current.hoverDelayMs ?? options.hoverGraceMs) ?? DEFAULT_HOVER_MS;
  const revealToolbar = () => {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = undefined;
    setToolbarVisible(true);
  };
  const concealToolbarSoon = () => {
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    // Read at fire time, not at mount time, so a settings change takes effect on
    // the very next hover instead of at the next page load.
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      setToolbarVisible(false);
    }, hoverGrace());
  };

  // Both elements keep the toolbar alive; only leaving one for somewhere that is
  // neither starts the countdown. Without the second pair, moving onto the toolbar
  // would inherit the character's pending hide and the buttons would vanish under
  // the pointer.
  for (const element of [root, toolbar]) {
    element.addEventListener('pointerenter', revealToolbar);
    element.addEventListener('pointerleave', concealToolbarSoon);
  }
  bubble.addEventListener('click', () => {
    // Clicking the bubble dismisses it. The state stays readable through the
    // toolbar, so dismissal is never a dead end.
    current = { ...current, hidden: true };
    writePreferences(options.storage, current);
    render();
  });

  // Dragging with pointer events: one code path for mouse, touch and pen, and it
  // does not depend on the browser's drag-and-drop, which would try to drag the
  // image itself.
  let drag;
  root.addEventListener('pointerdown', (event) => {
    drag = { dx: event.clientX - root.offsetLeft, dy: event.clientY - root.offsetTop, moved: false };
    root.setPointerCapture?.(event.pointerId);
    root.style.cursor = 'grabbing';
  });
  root.addEventListener('pointermove', (event) => {
    if (drag === undefined) return;
    drag.moved = true;
    current.position = clampPosition(
      { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
      { width: root.offsetWidth, height: root.offsetHeight },
      viewport(),
      EDGE_MARGIN,
    );
    // One placement path for every caller: the drag had its own copy of the bubble
    // and toolbar calls, which is how the two could disagree about where the
    // toolbar went and let the bubble land on top of it.
    place();
  });
  const endDrag = () => {
    if (drag === undefined) return;
    const moved = drag.moved;
    drag = undefined;
    root.style.cursor = 'grab';
    if (moved) writePreferences(options.storage, current);
    else {
      // A click without movement toggles the bubble: the character itself is the
      // most obvious control on screen.
      current = { ...current, hidden: !current.hidden };
      writePreferences(options.storage, current);
      render();
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  const onResize = () => place();
  view?.addEventListener?.('resize', onResize);
  const unsubscribe = options.subscribe?.(render);

  applySize();
  render();

  return {
    dispose() {
      disposed = true;
      if (hideTimer !== undefined) clearTimeout(hideTimer);
      hideTimer = undefined;
      unsubscribe?.();
      view?.removeEventListener?.('resize', onResize);
      root.remove();
      bubble.remove();
      toolbar.remove();
    },
    refresh: render,
    /**
     * Resize the character, keeping it on screen.
     *
     * Exposed so a settings control can drive it without remounting: a remount
     * would drop the toolbar mid-interaction and re-run the art cross-fade.
     *
     * @param {number} px - the requested height in pixels.
     * @param {{remember?: boolean}} [behaviour] - whether to persist the choice.
     * @returns {number} the size actually applied, after clamping.
     */
    setSize(px, behaviour = {}) {
      const size = clampSize(px) ?? DEFAULT_SIZE_PX;
      current = { ...current, sizePx: size };
      if (behaviour.remember !== false) writePreferences(options.storage, current);
      applySize();
      place();
      return size;
    },
    /**
     * Set how long the toolbar lingers after the pointer leaves.
     *
     * @param {number} ms - the requested period in milliseconds.
     * @returns {number} the period actually applied, after clamping.
     */
    setHoverGrace(ms) {
      const applied = clampHover(ms) ?? DEFAULT_HOVER_MS;
      current = { ...current, hoverDelayMs: applied };
      writePreferences(options.storage, current);
      return applied;
    },
    /**
     * Show or hide the character without tearing the badge down.
     *
     * Hiding keeps every listener and the last state: the settings page is one
     * click away, and re-showing must not replay the mount or lose the position.
     *
     * @param {boolean} visible - whether the character should be on screen.
     * @returns {void}
     */
    setVisible(visible) {
      const shown = visible !== false;
      root.style.display = shown ? 'block' : 'none';
      if (!shown) {
        // The bubble and the toolbar are separate elements; leaving them behind
        // would strand a panel with nothing to point at.
        if (hideTimer !== undefined) clearTimeout(hideTimer);
        hideTimer = undefined;
        setToolbarVisible(false);
        bubble.style.display = 'none';
        return;
      }
      render();
    },
    /**
     * Show text a command returned, for a while.
     * @param {string} text - the command's answer.
     * @param {number} [ms] - how long it stays, in milliseconds.
     * @returns {void}
     */
    showNotice(text, ms = 8000) {
      if (typeof text !== 'string' || text === '') return;
      notice = { text, untilMs: Date.now() + ms };
      render();
    },
    get state() {
      return lastState;
    },
  };
}
