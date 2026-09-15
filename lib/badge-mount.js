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

/** Where the badge remembers its position and bubble preference. */
const STORAGE_KEY = 'peak-valley-brake:badge';

/** Rendered height of the character, in pixels. */
const BADGE_HEIGHT = 96;

/** Gap kept from the viewport edges while dragging. */
const EDGE_MARGIN = 8;

/** Element id, so a re-mount replaces rather than duplicates the badge. */
const ROOT_ID = 'peak-valley-brake-badge';

/**
 * Read persisted preferences, tolerating a hostile or empty store.
 *
 * localStorage throws in private modes and when the origin is opaque, so every
 * access is guarded: a badge that cannot remember where it was placed must still
 * appear.
 *
 * @param {Storage|undefined} storage - the store, when available.
 * @returns {{position?: {x: number, y: number}, hidden?: boolean}} stored preferences.
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
    // `hidden` and `forceShow` are the names `shouldShowBubble` reads; keeping one
    // vocabulary across the two modules is what stops a dismissal from being
    // written under a key nothing consults.
    return {
      ...(position === undefined ? {} : { position }),
      ...(parsed.hidden === true ? { hidden: true } : {}),
      ...(parsed.forceShow === true ? { forceShow: true } : {}),
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
 * @returns {{dispose: () => void, refresh: () => void, showNotice: (text: string, ms?: number) => void, readonly state: object|undefined}} teardown, manual refresh, and one-off text.
 */
export function mountBadge(options) {
  const doc = options.document;
  const view = options.window;
  const art = options.art;
  const labels = options.labels ?? {};
  const preferences = readPreferences(options.storage);

  doc.getElementById?.(ROOT_ID)?.remove();

  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-state', 'idle');
  Object.assign(root.style, {
    position: 'fixed',
    zIndex: '2147483000',
    width: `${Math.round((BADGE_HEIGHT * 4) / 5)}px`,
    height: `${BADGE_HEIGHT}px`,
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
    background: 'var(--dsw-surface, #ffffff)',
    color: 'var(--dsw-text, #1a1a1a)',
    border: '1px solid var(--dsw-border, rgba(0,0,0,0.12))',
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
    background: 'var(--dsw-surface, #ffffff)',
    border: '1px solid var(--dsw-border, rgba(0,0,0,0.12))',
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

  /** Place the character, clamped to the visible area. */
  const place = () => {
    const size = { width: root.offsetWidth || Math.round((BADGE_HEIGHT * 4) / 5), height: BADGE_HEIGHT };
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
        background: button.enabled ? 'var(--dsw-accent, #2563eb)' : 'var(--dsw-border, rgba(0,0,0,0.08))',
        color: button.enabled ? '#ffffff' : 'var(--dsw-text-muted, #888)',
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

  root.addEventListener('pointerenter', () => setToolbarVisible(true));
  root.addEventListener('pointerleave', () => setToolbarVisible(false));
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

  render();

  return {
    dispose() {
      disposed = true;
      unsubscribe?.();
      view?.removeEventListener?.('resize', onResize);
      root.remove();
      bubble.remove();
      toolbar.remove();
    },
    refresh: render,
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
