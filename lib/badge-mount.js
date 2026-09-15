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
  BADGE_ACCENTS,
  BADGE_STATES,
  accentFor,
  badgeStateFor,
  bubbleOpensLeft,
  clampPosition,
  defaultPosition,
  panelFor,
  shouldShowBubble,
  toolbarFor,
} from './badge-view.js';
import {
  clampHover,
  clampPanelMs,
  clampSize,
  DEFAULT_HOVER_MS,
  DEFAULT_PANEL_MS,
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
  /** A floating panel's background, under the glass gradient. */
  surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
  /** A recessed surface, for controls that are present but unavailable. */
  recessed: 'var(--dsw-alias-bg-layer-2, #f1f3f5)',
  text: 'var(--dsw-alias-label-primary, #1e2d3d)',
  textMuted: 'var(--dsw-alias-label-secondary, #4b6175)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
  accent: 'var(--dsw-alias-brand-primary, #007aff)',
});

/** Element id, so a re-mount replaces rather than duplicates the badge. */
const ROOT_ID = 'peak-valley-brake-badge';

/**
 * The four toolbar glyphs, as Lucide outlines.
 *
 * Drawn as a mask rather than as an `<img>` or inline SVG: a mask takes its colour
 * from `background-color`, so one SVG serves the active and the inactive state and
 * the colour can come from the theme. `createElementNS` would be the other option
 * and is the one thing a test double cannot stand in for, which would leave the
 * icons untested.
 */
const ICON_BODIES = Object.freeze({
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
});

/**
 * Build the mask URL for one glyph.
 *
 * @param {string} name - the icon name `toolbarFor` chose.
 * @returns {string|undefined} a `url(...)` for `mask-image`, or undefined for an unknown name.
 */
function iconMaskUrl(name) {
  const body = ICON_BODIES[name];
  if (body === undefined) return undefined;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    `${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The colour a tab's text and its icon mask both take. */
function tabColourFor(selected) {
  if (selected) return 'var(--dsw-alias-brand-primary, #007aff)';
  return 'var(--dsw-alias-label-secondary, #4b6175)';
}

/**
 * The design's 32px bead, scaled to the size the badge draws it at.
 *
 * Every layer comes from the design's spec — 18px shell, 8px core, 4x3 glare, and a
 * halo of 22/28/30/28/36 per state — so the proportions are the design's even though
 * the absolute size is not.
 */
const BEAD_SCALE = 0.75;

/**
 * Which tab carries the design's selected treatment.
 *
 * The design marks exactly one tab with a lighter pill and the brand colour, and it is
 * the status one. That is also the only operation that can never be unavailable, so
 * the anchor of the bar and the tab that is always applicable turn out to be the same
 * tab.
 */
const SELECTED_TAB = 'status';

/** Id of the stylesheet this badge injects, so a re-mount reuses rather than stacks one. */
const STYLE_ID = 'peak-valley-brake-badge-style';

/**
 * The toolbar's fixed width: four tabs, three gaps and the bar's own padding.
 *
 * Stated rather than measured so the geometry code and a test double agree on it.
 * The alternative — reading `offsetWidth` — is zero in any environment that does not
 * lay out, which silently moves the panel to a different place than the browser
 * would put it.
 *
 * The tabs are 70 where the design draws 81, because the widest label here is four
 * characters: at 81 the row read as four islands inside a bar, and the design's tab is
 * sized for its own type rather than for this one.
 */
const TAB_WIDTH = 70;
const TAB_GAP = 4;
const TOOLBAR_PADDING = 6;
const TOOLBAR_WIDTH = 4 * TAB_WIDTH + 3 * TAB_GAP + 2 * TOOLBAR_PADDING;

/**
 * The badge's stylesheet — decoration only.
 *
 * **Structure is inline; this file adds polish.** That split is deliberate and was
 * learned the hard way: this project cannot observe whether an injected stylesheet is
 * applied in the operator's browser, so anything the badge's *shape* depends on has to
 * be an inline style, which is the one mechanism the rest of the geometry already
 * trusts. A row that is only a row because a class said `display: flex` is a row that
 * silently becomes three stacked blocks the day the sheet does not apply.
 *
 * What is left here is what inline styles genuinely cannot express: keyframes,
 * the `:hover` / `:focus-visible` / `[aria-pressed]` states, `backdrop-filter` with
 * its prefixed twin, and one `prefers-reduced-motion` block that switches the
 * movement off.
 */
const BADGE_CSS = `
@keyframes pvb-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-1.2%) scale(1.008); }
}
@keyframes pvb-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes pvb-glow {
  0%, 100% { opacity: 0.5; transform: translate(-50%, -50%) scale(0.92); }
  50% { opacity: 0.85; transform: translate(-50%, -50%) scale(1.06); }
}

.pvb-img { animation: pvb-breathe 4.5s ease-in-out infinite; transform-origin: 50% 90%; }
.pvb-root:hover .pvb-img { animation-play-state: paused; }
.pvb-panel { animation: pvb-pop 170ms cubic-bezier(0.2, 0.8, 0.3, 1); }
.pvb-bead-glow { animation: pvb-glow 3.2s ease-in-out infinite; }

/* Liquid glass: a translucent pane that takes its colour from whatever is behind it.
   The surface is mixed from theme tokens rather than hard-coded white, so the same rule
   frosts over a light page and a dark one — a fixed white overlay would have made this
   a light-mode-only design. Where color-mix is unsupported the whole declaration is
   dropped and the element keeps its inline theme background: a plainer panel rather
   than a broken one. */
.pvb-glass {
  background-image: linear-gradient(
    160deg,
    color-mix(in srgb, var(--dsw-alias-bg-overlay, #ffffff) 86%, transparent),
    color-mix(in srgb, var(--dsw-alias-bg-layer-2, #e0ecfa) 62%, transparent)
  );
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1.5px solid rgba(255, 255, 255, 0.7);
  box-shadow:
    0 12px 32px rgba(16, 42, 80, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

.pvb-tab { transition: background 140ms ease, color 140ms ease, transform 90ms ease, box-shadow 140ms ease; }
.pvb-tab:not(:disabled):hover { background: rgba(255, 255, 255, 0.5); transform: translateY(-1px); }
.pvb-tab:not(:disabled):active { transform: translateY(0); }
/* The selected tab is *lighter* than the bar it sits in, not tinted: the design fills
   it with white and lets the brand colour live only in its icon and label. Tinting it
   would have darkened the one tab meant to stand out. */
.pvb-tab[aria-pressed="true"] {
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #ffffff) 92%, currentColor 8%);
  border-color: rgba(255, 255, 255, 0.85);
  box-shadow: inset 0 1px 3px rgba(16, 42, 80, 0.10), inset 0 -1px 0 rgba(255, 255, 255, 0.7);
}
.pvb-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #007aff);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .pvb-img { animation: none; }
  .pvb-panel { animation: none; }
  .pvb-bead-glow { animation: none; }
  .pvb-tab { transition: none; }
}
`;

/**
 * Install the stylesheet once per document.
 *
 * Guarded and idempotent: the module system collects the `<style>` tags a factory
 * injects, and a re-mount — a settings change, a hot reload — must not stack a
 * second copy of the same rules.
 *
 * The stylesheet is deliberately *not* part of the teardown. It is inert, it is
 * shared by whichever mount created it first, and a mount that removed it on the way
 * out would strip the styling from a badge that is still on screen — the module
 * system already collects a factory's style tags when the plugin itself unloads,
 * which is the moment they are actually finished with.
 *
 * @param {Document} doc - the document to style.
 * @returns {void}
 */
function ensureStyles(doc) {
  try {
    if (doc.getElementById?.(STYLE_ID) !== null && doc.getElementById?.(STYLE_ID) !== undefined) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    // Claimed by name before the module system can claim it. The loader tags every
    // unclaimed `<style>` it finds with the id of whichever plugin materializes next,
    // and removes a plugin's styles when that plugin unloads — so an unmarked sheet is
    // one unrelated plugin reload away from silently disappearing.
    style.setAttribute?.('data-plugin', 'dsh-peak-valley-brake');
    style.textContent = BADGE_CSS;
    // `head` may be absent in a document that is still parsing; the rules work from
    // the body just as well.
    (doc.head ?? doc.body)?.appendChild(style);
  } catch {
    /* an unstyled badge is still a working badge */
  }
}

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
 * @param {number} [options.panelAutoHideMs] - how long a hand-opened panel stays up, when no stored preference exists.
 * @returns {{dispose: () => void, refresh: () => void, setSize: (px: number, behaviour?: object) => number, setHoverGrace: (ms: number) => number, setPanelLifetime: (ms: number) => number, setVisible: (visible: boolean) => void, showNotice: (text: string, ms?: number) => void, readonly state: object|undefined}} teardown, manual refresh, and the setters a settings page drives.
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
  if (preferences.panelAutoHideMs === undefined && clampPanelMs(options.panelAutoHideMs) !== undefined) {
    preferences.panelAutoHideMs = clampPanelMs(options.panelAutoHideMs);
  }

  doc.getElementById?.(ROOT_ID)?.remove();
  ensureStyles(doc);

  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.className = 'pvb-root';
  root.setAttribute('data-state', 'idle');
  Object.assign(root.style, {
    position: 'fixed',
    zIndex: '2147483000',
    userSelect: 'none',
    cursor: 'grab',
    touchAction: 'none',
    // A soft contact shadow, so the character reads as standing on the page rather
    // than pasted onto it. The elliptical ground shadow is a separate element,
    // because a drop-shadow follows the silhouette and this one must not.
    filter: 'drop-shadow(0 6px 12px rgba(0,0,0,0.22))',
    transition: 'opacity 200ms ease',
  });

  const shadow = doc.createElement('div');
  shadow.className = 'pvb-shadow';
  Object.assign(shadow.style, {
    position: 'absolute',
    left: '14%',
    right: '14%',
    bottom: '0',
    height: '10%',
    borderRadius: '50%',
    background: 'radial-gradient(ellipse at center, rgba(16, 42, 80, 0.20), rgba(16, 42, 80, 0) 70%)',
    pointerEvents: 'none',
  });

  const image = doc.createElement('img');
  image.className = 'pvb-img';
  image.alt = labels.alt ?? 'Peak/valley brake status';
  image.draggable = false;
  Object.assign(image.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
    transition: 'opacity 200ms ease',
  });

  // The state, at a glance, for when the panel has been dismissed and the toolbar is
  // hidden: a glass bead whose halo carries the state's intensity. Positions are inline
  // for the same reason the panel's rows are — the structure has to hold whether or not
  // the injected stylesheet is applied, and only the animation and the glow keyframes
  // are left to CSS.
  const bead = doc.createElement('div');
  bead.className = 'pvb-bead';
  Object.assign(bead.style, {
    position: 'absolute',
    right: '4%',
    bottom: '8%',
    width: '24px',
    height: '24px',
    pointerEvents: 'none',
  });
  const beadGlow = doc.createElement('div');
  beadGlow.className = 'pvb-bead-glow';
  Object.assign(beadGlow.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    borderRadius: '50%',
    filter: 'blur(6px)',
  });
  const beadShell = doc.createElement('div');
  beadShell.className = 'pvb-bead-shell';
  Object.assign(beadShell.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '14px',
    height: '14px',
    margin: '-7px 0 0 -7px',
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.9)',
    opacity: '0.65',
  });
  const beadCore = doc.createElement('div');
  beadCore.className = 'pvb-bead-core';
  Object.assign(beadCore.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '6px',
    height: '6px',
    margin: '-3px 0 0 -3px',
    borderRadius: '50%',
    boxShadow: '0 0 6px rgba(255, 255, 255, 0.8)',
  });
  const beadGlare = doc.createElement('div');
  beadGlare.className = 'pvb-bead-glare';
  Object.assign(beadGlare.style, {
    position: 'absolute',
    left: '37.5%',
    top: '37.5%',
    width: '12.5%',
    height: '9.4%',
    borderRadius: '50%',
    background: '#ffffff',
  });
  bead.appendChild(beadGlow);
  bead.appendChild(beadShell);
  bead.appendChild(beadCore);
  bead.appendChild(beadGlare);

  root.appendChild(shadow);
  root.appendChild(image);
  root.appendChild(bead);

  const bubble = doc.createElement('div');
  bubble.className = 'pvb-panel pvb-bubble pvb-glass';
  Object.assign(bubble.style, {
    position: 'fixed',
    // Narrower than the design's 340. With this plugin's labels — four characters at
    // most — that width left the middle of every row empty, and the empty middle was
    // the widest thing in the panel: it read as a gap between two columns rather than
    // as a label and its value.
    width: '296px',
    boxSizing: 'border-box',
    padding: '18px',
    borderRadius: '26px',
    background: THEME.surface,
    color: THEME.text,
    fontSize: '13px',
    lineHeight: '1.4',
    display: 'none',
  });
  doc.body.appendChild(root);
  doc.body.appendChild(bubble);

  const toolbar = doc.createElement('div');
  toolbar.className = 'pvb-panel pvb-toolbar pvb-glass';
  Object.assign(toolbar.style, {
    position: 'fixed',
    display: 'none',
    gap: `${TAB_GAP}px`,
    padding: `${TOOLBAR_PADDING}px`,
    width: `${TOOLBAR_WIDTH}px`,
    boxSizing: 'border-box',
    borderRadius: '28px',
    background: THEME.surface,
    color: THEME.text,
    fontSize: '12px',
  });
  doc.body.appendChild(toolbar);

  let current = { ...preferences };

  /** The bead the last render chose; the panel's accent row reads it. */
  let accent = BADGE_ACCENTS.idle;
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
    const width = toolbar.offsetWidth || TOOLBAR_WIDTH;
    const height = toolbar.offsetHeight || 64;
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

    // One bead, three surfaces. Deriving it from the same pose decision the
    // character just took is what keeps the bead, the panel's accent row and the
    // art from ever describing three different moments.
    accent = accentFor(state, Date.now());
    const glowPx = Math.round(accent.glow * BEAD_SCALE);
    Object.assign(beadGlow.style, { width: `${glowPx}px`, height: `${glowPx}px`, background: accent.shell });
    beadShell.style.background = accent.shell;
    beadCore.style.background = accent.core;

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
      // An answer to something the operator just clicked replaces the panel even
      // when it was dismissed: dismissal hides standing information, not a reply.
      renderNotice(notice.text);
      return;
    }
    notice = undefined;
    const panel = panelFor(state, Date.now(), labels);
    if (panel === undefined || !shouldShowBubble(state, current)) {
      bubble.style.display = 'none';
      return;
    }
    renderPanel(panel);
  };

  /**
   * Draw the panel: a titled header, a hairline, then the rows.
   *
   * The title and the rows are rebuilt on every render, which is affordable because
   * the whole panel is a dozen nodes and only exists while it is on screen. Keeping
   * it declarative means a row cannot survive a state change that should have
   * removed it.
   *
   * @param {{title: string, badge: string|null, rows: object[]}} panel - the composed panel.
   * @returns {void}
   */
  const renderPanel = (panel) => {
    bubble.textContent = '';

    const header = doc.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' });

    const titleWrap = doc.createElement('div');
    Object.assign(titleWrap.style, { display: 'flex', alignItems: 'center', gap: '8px' });
    // A solid mark with a halo around it, rather than one blurred dot. The design's
    // `water-glow` is a *lit* dot: blurring the whole thing made it look out of focus
    // rather than glowing, and at 10px there is no room to be both.
    const glow = doc.createElement('span');
    Object.assign(glow.style, {
      position: 'relative',
      width: '10px',
      height: '10px',
      flex: '0 0 auto',
    });
    const glowHalo = doc.createElement('span');
    Object.assign(glowHalo.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '20px',
      height: '20px',
      margin: '-10px 0 0 -10px',
      borderRadius: '50%',
      background: THEME.accent,
      opacity: '0.35',
      filter: 'blur(5px)',
    });
    const glowCore = doc.createElement('span');
    Object.assign(glowCore.style, {
      position: 'absolute',
      inset: '0',
      borderRadius: '50%',
      background: THEME.accent,
    });
    glow.appendChild(glowHalo);
    glow.appendChild(glowCore);
    const title = doc.createElement('span');
    title.className = 'pvb-panel-title';
    Object.assign(title.style, { fontSize: '16px', fontWeight: '700' });
    title.textContent = panel.title;
    titleWrap.appendChild(glow);
    titleWrap.appendChild(title);
    header.appendChild(titleWrap);

    if (panel.badge !== null) {
      const badge = doc.createElement('span');
      badge.className = 'pvb-badge';
      // The panel's own colour, which the design fixes: the header mark and the LIVE pill
      // are brand blue in every state. Deriving them from the state accent turned the
      // whole header grey whenever the tariff was off-peak — which reads as "something is
      // wrong", not as "everything is cheap". The tariff's colour is carried by the row
      // mark, where the design puts it.
      Object.assign(badge.style, {
        fontSize: '10px',
        fontWeight: '600',
        letterSpacing: '0.06em',
        padding: '3px 8px',
        borderRadius: '100px',
        border: '1px solid currentColor',
        color: THEME.accent,
        background: `color-mix(in srgb, ${THEME.accent} 12%, transparent)`,
      });
      badge.textContent = panel.badge;
      header.appendChild(badge);
    }
    bubble.appendChild(header);

    const divider = doc.createElement('div');
    divider.className = 'pvb-divider';
    Object.assign(divider.style, { height: '1px', background: 'rgba(255, 255, 255, 0.75)', margin: '14px 0' });
    bubble.appendChild(divider);

    const grid = doc.createElement('div');
    Object.assign(grid.style, { display: 'flex', flexDirection: 'column', gap: '10px' });
    for (const row of panel.rows) grid.appendChild(renderRow(row));
    bubble.appendChild(grid);

    bubble.style.display = 'block';
  };

  /**
   * Draw one label/value row.
   *
   * @param {{label: string, value: string, tone: string, dotColour: string|null}} row - the row.
   * @returns {object} the row element.
   */
  const renderRow = (row) => {
    const element = doc.createElement('div');
    element.className = 'pvb-row';
    // The row's layout is inline, not in the stylesheet, and that is the whole point:
    // label hard left, value hard right is the design's tidiest property and this
    // project cannot test whether an injected stylesheet is applied. Decoration can
    // live in CSS; the structure that makes a row a row cannot.
    Object.assign(element.style, {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '12px',
    });

    const label = doc.createElement('span');
    label.className = 'pvb-row-label';
    label.textContent = row.label;
    Object.assign(label.style, {
      fontSize: '13px',
      fontWeight: '500',
      color: THEME.textMuted,
      whiteSpace: 'nowrap',
    });

    const value = doc.createElement('span');
    // The tariff value is 600 in the design and the rest are 500: at one size, weight
    // is what makes the one number that matters read first.
    value.className = row.tone === 'accent' ? 'pvb-row-value pvb-row-value--strong' : 'pvb-row-value';
    Object.assign(value.style, {
      fontSize: '13px',
      fontWeight: row.tone === 'accent' ? '600' : '500',
      textAlign: 'right',
      flex: '1 1 auto',
    });
    if (row.dotColour !== null) {
      const dot = doc.createElement('span');
      dot.className = 'pvb-row-dot';
      Object.assign(dot.style, {
        display: 'inline-block',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        marginRight: '6px',
        background: row.dotColour,
      });
      value.appendChild(dot);
    }
    const text = doc.createElement('span');
    text.textContent = row.value;
    // Three weights, as the design has: brand blue for the values that are the point
    // of the panel, the alarming red for the one costly state, and muted for "none".
    if (row.tone === 'accent') text.style.color = THEME.accent;
    else if (row.tone === 'danger') text.style.color = BADGE_ACCENTS.override.shell;
    else if (row.tone === 'muted') text.style.color = THEME.textMuted;
    value.appendChild(text);

    element.appendChild(label);
    element.appendChild(value);
    return element;
  };

  /**
   * Draw a command's answer, one row per line.
   *
   * Deliberately not the panel: this is prose the host produced, and dressing it up
   * as a dashboard would make an error message look like telemetry.
   *
   * @param {string} text - the command's answer.
   * @returns {void}
   */
  const renderNotice = (text) => {
    bubble.textContent = '';
    for (const line of text.split('\n').filter((value) => value !== '')) {
      const row = doc.createElement('div');
      row.className = 'pvb-row-value';
      row.style.textAlign = 'left';
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
      element.className = 'pvb-tab';
      element.disabled = !button.enabled;
      if (button.hint !== '') element.title = button.hint;
      // The design marks the selected tab with `aria-pressed`, and the selected tab is
      // the status one — the only operation that is never unavailable, so the mark is
      // always on something that works.
      // The design marks the selected tab, and the tab it marks is the status one. The
      // mark is tied to whether the panel is actually open, so it states a fact rather
      // than decorating a button: highlight it and the panel is there.
      const selected = button.action === SELECTED_TAB && bubble.style.display === 'block';
      element.setAttribute('aria-pressed', String(selected));
      // Icon over label, in a fixed pill. Inline for the same reason the panel's rows
      // are: the shape has to hold whether or not the injected stylesheet is applied,
      // and only the hover, the focus ring and the selected fill are left to CSS.
      Object.assign(element.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '2px',
        width: `${TAB_WIDTH}px`,
        height: '44px',
        padding: '0',
        border: '1px solid transparent',
        borderRadius: '22px',
        background: 'transparent',
        font: 'inherit',
        cursor: button.enabled ? 'pointer' : 'not-allowed',
        opacity: button.enabled ? '1' : '0.45',
        color: tabColourFor(selected),
      });

      const icon = doc.createElement('span');
      icon.className = 'pvb-tab-icon';
      const mask = iconMaskUrl(button.icon);
      if (mask !== undefined) {
        Object.assign(icon.style, {
          width: '18px',
          height: '18px',
          backgroundColor: 'currentColor',
          maskImage: mask,
          webkitMaskImage: mask,
          maskRepeat: 'no-repeat',
          webkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          webkitMaskPosition: 'center',
          maskSize: 'contain',
          webkitMaskSize: 'contain',
        });
        element.appendChild(icon);
      }

      const label = doc.createElement('span');
      label.className = 'pvb-tab-label';
      Object.assign(label.style, { fontSize: '10px', fontWeight: '600', letterSpacing: '0.02em', lineHeight: '1.2' });
      label.textContent = button.label;
      element.appendChild(label);

      element.addEventListener('click', (event) => {
        event.stopPropagation();
        void act(button.action);
      });
      toolbar.appendChild(element);
    }
  };

  /**
   * Post one toolbar action, then re-read the state.
   *
   * The status tab is the exception, and deliberately so: **the panel is the status**.
   * It used to ask the host for the `/peak-valley status` text and print that, which is a
   * paragraph about the same facts the panel already draws as a dashboard — so clicking
   * the one tab the design highlights produced something that looked nothing like the
   * design. It now pins the panel open instead: no round trip, always current because the
   * poll refreshes it, and drawn as the same six rows.
   *
   * The endpoint keeps its `status` action; the badge simply has a better answer to it.
   *
   * @param {string} action - the action to perform.
   * @returns {Promise<void>} resolution after the state is re-read.
   */
  const act = async (action) => {
    if (action === 'status') {
      const pinned = current.forceShow !== true;
      current = { ...current, forceShow: pinned, ...(pinned ? { hidden: false } : {}) };
      writePreferences(options.storage, current);
      render();
      schedulePanelHide(pinned);
      return;
    }
    try {
      await options.postAction(action);
    } catch {
      /* the badge reports through the bubble, not by throwing into the page */
    }
    render();
  };

  /**
   * Arm the countdown that closes a panel the operator opened.
   *
   * Only a hand-opened panel times out. One that appeared because work is being held, or
   * because the brake is about to engage, is reporting a *situation* and disappears when
   * that situation does — putting a timer on it would take the explanation away while the
   * condition it explains is still true.
   *
   * A lifetime of zero means "leave it up", which is what an operator who wants a
   * standing readout will set.
   *
   * @param {boolean} pinned - whether the panel was just opened by hand.
   * @returns {void}
   */
  const schedulePanelHide = (pinned) => {
    if (panelTimer !== undefined) clearTimeout(panelTimer);
    panelTimer = undefined;
    if (!pinned) return;
    const lifetime = panelLifetimeMs();
    if (lifetime <= 0) return;
    panelTimer = setTimeout(() => {
      panelTimer = undefined;
      if (disposed) return;
      current = { ...current, forceShow: false };
      writePreferences(options.storage, current);
      render();
    }, lifetime);
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

  /** How long a hand-opened panel stays up, in force right now. */
  const panelLifetimeMs = () =>
    clampPanelMs(current.panelAutoHideMs ?? options.panelAutoHideMs) ?? DEFAULT_PANEL_MS;

  /** The pending auto-hide, so a second click or a teardown can cancel it. */
  let panelTimer;
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
      if (panelTimer !== undefined) clearTimeout(panelTimer);
      panelTimer = undefined;
      unsubscribe?.();
      view?.removeEventListener?.('resize', onResize);
      root.remove();
      bubble.remove();
      toolbar.remove();
      // The stylesheet stays: it is inert, shared, and the module system removes it
      // when the plugin unloads. See `ensureStyles`.
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
     * Set how long a hand-opened panel stays up.
     *
     * @param {number} ms - the requested period in milliseconds; zero leaves it open.
     * @returns {number} the period actually applied, after clamping.
     */
    setPanelLifetime(ms) {
      const applied = clampPanelMs(ms) ?? DEFAULT_PANEL_MS;
      current = { ...current, panelAutoHideMs: applied };
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
