/**
 * Self-check for the badge's DOM behaviour, driven against a minimal fake
 * document.
 *
 * Run with `node test/badge-mount.test.mjs`.
 *
 * The badge's appearance cannot be checked here — that is the one property left
 * to a human with a browser. Everything around it can be: which element gets
 * which art, what the bubble says, when the toolbar is offered, what a button
 * posts, and whether the whole thing tears down without leaving orphans in the
 * operator's page. That is what this file covers, with a clock the test owns so
 * nothing depends on how fast the machine is.
 *
 * @module peak-valley-brake/test/badge-mount
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { mountBadge, readPreferences, writePreferences, DEFAULT_SIZE_PX, MAX_SIZE_PX, MIN_SIZE_PX } from '../lib/badge-mount.js';

const results = { passed: 0, failed: 0 };

/**
 * Run one named case and record its outcome.
 * @param {string} caseName - the case name.
 * @param {() => Promise<void> | void} body - case body.
 * @returns {Promise<void>} resolution after the case settles.
 */
async function test(caseName, body) {
  try {
    await body();
    results.passed += 1;
    process.stdout.write(`  ok   ${caseName}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${caseName}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Art stub: one distinct string per state, so the assertions read as states. */
const ART = Object.freeze({
  idle: 'art:idle',
  armed: 'art:armed',
  held: 'art:held',
  released: 'art:released',
});

/**
 * Create one fake element.
 *
 * Only what the badge touches: children, inline style, attributes, listeners and
 * the two measurement properties the positioning code reads.
 *
 * @param {string} tagName - the element's tag.
 * @returns {object} the fake element.
 */
function createElement(tagName) {
  const element = {
    tagName,
    children: [],
    style: {},
    attributes: {},
    listeners: new Map(),
    id: '',
    type: '',
    title: '',
    src: '',
    alt: '',
    disabled: false,
    draggable: true,
    parent: undefined,
    /**
     * The element's box, as a browser would report it.
     *
     * This used to be two fixed numbers, which quietly made every geometry
     * assertion meaningless: the code sized the character from its own state while
     * the fake kept claiming 96px, so a placement that was correct looked wrong and
     * one that was wrong could look correct. Sizes now come from the element's own
     * inline style, with the same content-derived fallbacks the real layout would
     * produce for the bubble and the toolbar.
     */
    get offsetWidth() {
      const explicit = Number.parseFloat(this.style.width);
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      if (this.style.minWidth === '150px') return 180;
      if (this.style.gap === '4px') return 240;
      return 0;
    },
    get offsetHeight() {
      const explicit = Number.parseFloat(this.style.height);
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      if (this.style.minWidth === '150px') return 60;
      if (this.style.gap === '4px') return 34;
      return 0;
    },
    /** Follow the inline position the badge writes, as a real element would. */
    get offsetLeft() {
      return Number.parseFloat(this.style.left) || 0;
    },
    get offsetTop() {
      return Number.parseFloat(this.style.top) || 0;
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    },
    remove() {
      if (this.parent === undefined) return;
      const index = this.parent.children.indexOf(this);
      if (index !== -1) this.parent.children.splice(index, 1);
      this.parent = undefined;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    setPointerCapture() {},
    /**
     * Fire one event at this element.
     *
     * A disabled button dispatches nothing, which is what a browser does — and
     * the property the badge relies on to make "release" unavailable while
     * nothing is held.
     *
     * @param {string} type - the event type.
     * @param {object} [event] - the event payload.
     * @returns {void}
     */
    emit(type, event = {}) {
      if (type === 'click' && this.disabled === true) return;
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    },
    get textContent() {
      return this.children.length > 0
        ? this.children.map((child) => child.textContent).join('')
        : (this._text ?? '');
    },
    set textContent(value) {
      // Assigning text replaces the children, which is how the badge fills the
      // bubble: clear, then append one row per line.
      this.children = [];
      this._text = String(value);
    },
  };
  return element;
}

/**
 * Create a fake document with a body and a getElementById over mounted roots.
 * @returns {object} the fake document.
 */
function createDocument() {
  const body = createElement('body');
  const document_ = {
    body,
    createElement,
    addEventListener() {},
    getElementById(id) {
      return body.children.find((child) => child.id === id);
    },
  };
  return document_;
}

/**
 * Create a fake window.
 * @returns {object} the fake window.
 */
function createWindow() {
  return { innerWidth: 1200, innerHeight: 800, listeners: new Map(), addEventListener() {}, removeEventListener() {} };
}

/**
 * Create a fake localStorage.
 * @returns {object} the fake storage.
 */
function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/**
 * Mount a badge over fresh fakes.
 * @param {object} [options] - overrides.
 * @param {object} [options.state] - the state `readState` returns.
 * @param {Function} [options.postAction] - the action poster.
 * @returns {object} the mounting fakes and the badge handle.
 */
function mount(options = {}) {
  const document_ = createDocument();
  const window_ = createWindow();
  const storage = options.storage ?? createStorage();
  const posted = [];
  const badge = mountBadge({
    document: document_,
    window: window_,
    storage,
    art: ART,
    labels: { alt: 'state', held: 'held', count: 'messages', autoRelease: 'auto', cancelHint: 'cancel', status: 'status', now: 'now', window: 'window', cancel: 'cancel' },
    readState: () => options.state,
    postAction:
      options.postAction ??
      ((action) => {
        posted.push(action);
        return Promise.resolve({ ok: true });
      }),
    subscribe: options.subscribe,
    // Zero by default so a case that only cares about the end state does not have
    // to sleep; the cases about the grace period ask for a real one.
    hoverGraceMs: options.hoverGraceMs ?? 0,
    ...(options.sizePx === undefined ? {} : { sizePx: options.sizePx }),
    ...(options.panelAutoHideMs === undefined ? {} : { panelAutoHideMs: options.panelAutoHideMs }),
  });
  const root = document_.body.children.find((child) => child.id === 'peak-valley-brake-badge');
  const bubble = document_.body.children.find((child) => child !== root && child.style.borderRadius === '10px' && child.tagName === 'div' && child.children.length >= 0 && child !== root);
  return { document: document_, window: window_, storage, badge, root, bubble, posted, body: document_.body };
}

/** Let a pending zero-delay timer run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait real milliseconds, for the cases that assert the grace period. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The bubble and the toolbar, found by their own class hooks.
 *
 * These used to be found by sniffing a style value — the bubble by its `min-width`,
 * the toolbar by its `gap`. That coupled the suite to a cosmetic number: changing
 * the toolbar's spacing made every geometry case fail with "cannot read properties
 * of undefined", which says nothing about what actually broke. Class names are the
 * stable contract.
 */
function bubbleOf(document_) {
  return document_.body.children.find((child) => String(child.className ?? '').includes('pvb-bubble'));
}

/** The toolbar, by its own class hook. */
function toolbarOf(document_) {
  return document_.body.children.find((child) => String(child.className ?? '').includes('pvb-toolbar'));
}

/** The status bead inside the character's element. */
function beadOf(document_) {
  return document_.body.children
    .find((child) => child.id === 'peak-valley-brake-badge')
    ?.children.find((child) => String(child.className ?? '').includes('pvb-bead'));
}

/** One layer of the bead, by its class. */
function beadLayer(document_, layer) {
  return beadOf(document_)?.children.find((child) => String(child.className ?? '') === `pvb-bead-${layer}`);
}

/** The character's image element. */
function imageOf(document_) {
  return document_.body.children
    .find((child) => child.id === 'peak-valley-brake-badge')
    ?.children.find((child) => child.tagName === 'img');
}

process.stdout.write('peak-valley-brake badge mounting\n\n');

process.stdout.write('what it draws\n');

await test('every custom property it reads is a real theme token', async () => {
  // The badge's first version styled itself with `--dsw-surface`, `--dsw-text` and
  // `--dsw-border`. None of those exist: the theme's tokens are all `--dsw-alias-*`
  // (the theme service's built-in token directory is the authority). An unknown
  // custom property is not an error in CSS, it is simply nothing — so every element
  // quietly used its light-mode fallback and the badge would have stayed a white
  // box on a dark theme, with no symptom anywhere to explain it. This asserts the
  // prefix, so the next invented name fails here instead of in someone's dark mode.
  const source = await readFile(new URL('../lib/badge-mount.js', import.meta.url), 'utf8');
  const names = [...source.matchAll(/var\((--[a-z0-9-]+)/giu)].map((match) => match[1]);
  assert.ok(names.length > 0, 'the badge must take its colours from the theme');
  for (const name of names) {
    assert.ok(name.startsWith('--dsw-alias-'), `${name} is not a theme token`);
  }
});

await test('a badge mounts with the idle character and no bubble', () => {
  const { badge, root, document: doc } = mount();
  assert.ok(root !== undefined, 'the badge element must be in the body');
  assert.equal(root.attributes['data-state'], 'idle');
  assert.equal(bubbleOf(doc).style.display, 'none');
  badge.dispose();
});

await test('a held state shows the withholding character and says how much is held', () => {
  const state = { engaged: true, heldCount: 3, releaseAtMs: Date.now() + 3_600_000, overrideActive: false };
  const { badge, root, document: doc } = mount({ state });
  assert.equal(root.attributes['data-state'], 'held');
  const text = bubbleOf(doc).textContent;
  assert.match(text, /3/u, 'the count must be visible without opening anything');
  badge.dispose();
});

await test('a live override is surfaced even with nothing held', () => {
  const state = { engaged: false, heldCount: 0, overrideActive: true, overrideUntilMs: Date.now() + 60_000 };
  const { badge, document: doc } = mount({ state });
  assert.notEqual(bubbleOf(doc).style.display, 'none', 'an override costs money and must be visible');
  badge.dispose();
});

await test('an absent state is drawn as idle rather than throwing', () => {
  const { badge, root } = mount({ state: undefined });
  assert.equal(root.attributes['data-state'], 'idle');
  badge.dispose();
});

await test('an unknown state falls back to the idle art instead of a broken image', () => {
  const { badge, root } = mount({ state: { engaged: true, heldCount: 1, phase: 'not-a-phase' } });
  assert.ok(['idle', 'armed', 'held', 'released'].includes(root.attributes['data-state']));
  badge.dispose();
});

process.stdout.write('\nthe toolbar\n');

await test('the toolbar is hidden until the pointer arrives', async () => {
  const { badge, root, document: doc } = mount();
  assert.equal(toolbarOf(doc).style.display, 'none');
  root.emit('pointerenter');
  assert.equal(toolbarOf(doc).style.display, 'flex');
  root.emit('pointerleave');
  await settle();
  assert.equal(toolbarOf(doc).style.display, 'none');
  badge.dispose();
});

await test('the toolbar survives the gap between the character and its buttons', async () => {
  // The reason this test exists: the toolbar is positioned outside the character's
  // box, so reaching a button always crosses a strip belonging to neither element.
  // Hiding on the first `pointerleave` made every button unpressable — the toolbar
  // vanished mid-crossing. Reaching the toolbar must cancel the pending hide.
  const { badge, root, document: doc } = mount({ hoverGraceMs: 150 });
  root.emit('pointerenter');
  root.emit('pointerleave'); // stepping off the character...
  toolbarOf(doc).emit('pointerenter'); // ...onto the toolbar
  await wait(300);
  assert.equal(toolbarOf(doc).style.display, 'flex', 'the buttons must still be there to press');
  badge.dispose();
});

await test('a brief slip of the pointer does not take the toolbar away', async () => {
  const { badge, root, document: doc } = mount({ hoverGraceMs: 150 });
  root.emit('pointerenter');
  root.emit('pointerleave');
  await wait(20);
  assert.equal(toolbarOf(doc).style.display, 'flex', 'well inside the grace period');
  badge.dispose();
});

await test('the toolbar does go away once the pointer has really left', async () => {
  const { badge, root, document: doc } = mount({ hoverGraceMs: 150 });
  root.emit('pointerenter');
  root.emit('pointerleave');
  await wait(400);
  assert.equal(toolbarOf(doc).style.display, 'none', 'a hover menu that never leaves is furniture');
  badge.dispose();
});

await test('clicking a button keeps the toolbar up, so a second one is reachable', async () => {
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 3_600_000 };
  const { badge, root, document: doc } = mount({ state, hoverGraceMs: 150 });
  root.emit('pointerenter');
  const button = toolbarOf(doc).children.find((candidate) => candidate.disabled !== true);
  button.emit('click', { stopPropagation() {} });
  await wait(50);
  assert.equal(toolbarOf(doc).style.display, 'flex');
  badge.dispose();
});

await test('disposing stops a pending hide from touching a torn-down badge', async () => {
  const { badge, root } = mount({ hoverGraceMs: 150 });
  root.emit('pointerenter');
  root.emit('pointerleave');
  badge.dispose();
  await wait(300);
  // Reaching here without an exception is the assertion: the timer must not fire
  // against removed elements.
  assert.ok(true);
});

await test('the toolbar never covers the character', () => {
  // The badge rests 24px from the bottom edge, so a toolbar placed below it would
  // fall out of the viewport — and the first version clamped it to a fixed offset
  // that sat 16px ABOVE the badge's own bottom edge, covering the character's feet
  // at the default position. It has to go above instead.
  const { badge, root, document: doc } = mount();
  root.emit('pointerenter');
  const toolbar = toolbarOf(doc);
  const badgeTop = Number.parseFloat(root.style.top);
  const badgeBottom = badgeTop + root.offsetHeight;
  const toolbarTop = Number.parseFloat(toolbar.style.top);
  const toolbarBottom = toolbarTop + toolbar.offsetHeight;
  assert.equal(
    toolbarTop < badgeBottom && toolbarBottom > badgeTop,
    false,
    `the toolbar (${toolbarTop}..${toolbarBottom}) overlaps the character (${badgeTop}..${badgeBottom})`,
  );
  assert.ok(toolbarTop >= 0, 'and it must stay inside the viewport');
  badge.dispose();
});

await test('the toolbar goes below when the character has room under it', () => {
  // The complement of the case above: the flip is conditional, not the toolbar
  // simply moving to the top of the screen.
  const { badge, root, document: doc } = mount();
  root.emit('pointerdown', { clientX: 400, clientY: 200, pointerId: 1 });
  root.emit('pointermove', { clientX: 300, clientY: 40 });
  root.emit('pointerup', {});
  root.emit('pointerenter');
  const badgeBottom = Number.parseFloat(root.style.top) + root.offsetHeight;
  assert.ok(
    Number.parseFloat(toolbarOf(doc).style.top) >= badgeBottom,
    'with the character near the top, the toolbar belongs underneath it',
  );
  badge.dispose();
});

await test('the bubble does not land on top of the toolbar', () => {
  // Both want the space above the character, and during a hold they are on screen
  // together the moment the pointer arrives: the toolbar flips above at the
  // default resting place, and the bubble is always above. The bubble therefore
  // has to clear the toolbar rather than share the spot.
  const state = { engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000 };
  const { badge, root, document: doc } = mount({ state });
  root.emit('pointerenter');

  const bubbleTop = Number.parseFloat(bubbleOf(doc).style.top);
  const bubbleBottom = bubbleTop + bubbleOf(doc).offsetHeight;
  const toolbarTop = Number.parseFloat(toolbarOf(doc).style.top);
  const toolbarBottom = toolbarTop + toolbarOf(doc).offsetHeight;

  assert.equal(bubbleOf(doc).style.display, 'block', 'a hold must show the bubble');
  assert.equal(toolbarOf(doc).style.display, 'flex', 'hovering must show the toolbar');
  assert.equal(
    bubbleTop < toolbarBottom && bubbleBottom > toolbarTop,
    false,
    `the bubble (${bubbleTop}..${bubbleBottom}) overlaps the toolbar (${toolbarTop}..${toolbarBottom})`,
  );
  assert.ok(bubbleTop >= 0, 'and the bubble must stay inside the viewport');
  badge.dispose();
});

await test('the bubble stays clear while the character is dragged', () => {
  // The drag path used to place the bubble and the toolbar itself, so a drag could
  // put them back on top of each other.
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 3_600_000 };
  const { badge, root, document: doc } = mount({ state });
  root.emit('pointerenter');
  for (const spot of [{ x: 900, y: 60 }, { x: 120, y: 700 }, { x: 600, y: 400 }]) {
    root.emit('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    root.emit('pointermove', { clientX: spot.x, clientY: spot.y });
    root.emit('pointerup', {});
  }
  const bubbleTop = Number.parseFloat(bubbleOf(doc).style.top);
  const bubbleBottom = bubbleTop + bubbleOf(doc).offsetHeight;
  const toolbarTop = Number.parseFloat(toolbarOf(doc).style.top);
  const toolbarBottom = toolbarTop + toolbarOf(doc).offsetHeight;
  assert.equal(
    bubbleTop < toolbarBottom && bubbleBottom > toolbarTop,
    false,
    `after dragging, the bubble (${bubbleTop}..${bubbleBottom}) overlaps the toolbar (${toolbarTop}..${toolbarBottom})`,
  );
  badge.dispose();
});

await test('every toolbar button posts an action the endpoint accepts', async () => {
  const state = { engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000, overrideActive: true, overrideUntilMs: Date.now() + 60_000 };
  const { badge, root, document: doc, posted } = mount({ state });
  root.emit('pointerenter');
  const toolbar = toolbarOf(doc);
  assert.ok(toolbar.children.length >= 2, 'a held override offers several operations');
  for (const button of toolbar.children) {
    button.emit('click', { stopPropagation() {} });
  }
  await Promise.resolve();
  assert.ok(posted.length >= 2);
  for (const action of posted) {
    assert.ok(['status', 'now', 'window', 'cancel', 'poll'].includes(action), `${action} is not in the vocabulary`);
  }
  badge.dispose();
});

await test('a disabled button cannot post anything', async () => {
  const { badge, root, document: doc, posted } = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
  root.emit('pointerenter');
  const disabled = toolbarOf(doc).children.filter((button) => button.disabled);
  assert.equal(disabled.length, 3, 'with nothing held and no override, only status is offered');
  for (const button of disabled) button.emit('click', { stopPropagation() {} });
  await Promise.resolve();
  assert.equal(posted.length, 0);
  badge.dispose();
});

await test('a throwing action poster does not throw into the page', async () => {
  const { badge, root, document: doc } = mount({
    state: { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 1000 },
    postAction: () => Promise.reject(new Error('offline')),
  });
  root.emit('pointerenter');
  await assert.doesNotReject(async () => {
    for (const button of toolbarOf(doc).children) {
      button.emit('click', { stopPropagation() {} });
    }
    await Promise.resolve();
  });
  badge.dispose();
});

process.stdout.write('\nthe bubble\n');

await test('clicking the character hides the bubble and remembers it', () => {
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 60_000 };
  const { badge, root, document: doc, storage } = mount({ state });
  assert.notEqual(bubbleOf(doc).style.display, 'none');
  root.emit('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
  root.emit('pointerup', {});
  assert.equal(bubbleOf(doc).style.display, 'none');
  assert.equal(readPreferences(storage).hidden, true, 'the preference must survive a reload');
  badge.dispose();
});

await test('a dismissed bubble stays dismissed on the next mount', () => {
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 60_000 };
  const storage = createStorage();
  writePreferences(storage, { hidden: true });
  const document_ = createDocument();
  const badge = mountBadge({
    document: document_,
    window: createWindow(),
    storage,
    art: ART,
    labels: {},
    readState: () => state,
    postAction: () => Promise.resolve({ ok: true }),
  });
  assert.equal(bubbleOf(document_).style.display, 'none');
  badge.dispose();
});

await test('a command answer replaces the bubble and expires on its own', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { badge, document: doc } = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
    const bubble = bubbleOf(doc);
    assert.equal(bubble.style.display, 'none', 'nothing to say while idle');

    badge.showNotice('峰时未到，已放行一次', 8000);
    assert.equal(bubble.style.display, 'block');
    assert.match(bubble.textContent, /已放行一次/u);

    now += 8001;
    badge.refresh();
    assert.equal(bubble.style.display, 'none', 'the answer must not become permanent furniture');
    badge.dispose();
  } finally {
    Date.now = realNow;
  }
});

await test('an answer is shown even when the status bubble was dismissed', () => {
  // Dismissal hides standing information. An answer to a button the operator
  // just pressed is not standing information.
  const { badge, document: doc, storage } = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
  writePreferences(storage, { hidden: true });
  badge.showNotice('ok');
  assert.equal(bubbleOf(doc).style.display, 'block');
  badge.dispose();
});

await test('an empty answer shows nothing rather than an empty box', () => {
  const { badge, document: doc } = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
  badge.showNotice('');
  assert.equal(bubbleOf(doc).style.display, 'none');
  badge.dispose();
});

process.stdout.write('\nthe size\n');

await test('the character renders at a size you can actually see', () => {
  // The first build rendered at 96px, which sampled the art well below one image
  // pixel per device pixel and read as blurry rather than merely small.
  const { badge, root } = mount();
  assert.equal(Number.parseFloat(root.style.height), DEFAULT_SIZE_PX);
  assert.ok(DEFAULT_SIZE_PX >= 128, 'the default must be legible without configuring anything');
  badge.dispose();
});

await test('a stored size is honoured on the next mount', () => {
  const storage = createStorage();
  writePreferences(storage, { sizePx: 220 });
  const { badge, root } = mount({ storage });
  assert.equal(Number.parseFloat(root.style.height), 220);
  badge.dispose();
});

await test('a stored size outside the range is brought back into it', () => {
  // A hand-edited or hostile store must not produce a 4-pixel or 4000-pixel badge.
  for (const [stored, expected] of [[1, MIN_SIZE_PX], [99999, MAX_SIZE_PX], ['huge', DEFAULT_SIZE_PX]]) {
    const storage = createStorage();
    writePreferences(storage, { sizePx: stored });
    const { badge, root } = mount({ storage });
    assert.equal(Number.parseFloat(root.style.height), expected, `${JSON.stringify(stored)} must resolve to ${expected}`);
    badge.dispose();
  }
});

await test('setSize clamps, persists, and reports what it applied', () => {
  const { badge, root, storage } = mount();
  assert.equal(badge.setSize(200), 200);
  assert.equal(Number.parseFloat(root.style.height), 200);
  assert.equal(readPreferences(storage).sizePx, 200, 'a resize must survive a reload');
  assert.equal(badge.setSize(10), MIN_SIZE_PX, 'and must report the clamped value, not the request');
  assert.equal(badge.setSize(99999), MAX_SIZE_PX);
  badge.dispose();
});

await test('an option size only applies when nothing was ever stored', () => {
  // Otherwise the host's configured default would silently undo the operator's own
  // choice every time the page reloaded.
  const storage = createStorage();
  writePreferences(storage, { sizePx: 300 });
  const { badge, root } = mount({ storage, sizePx: 100 });
  assert.equal(Number.parseFloat(root.style.height), 300);
  badge.dispose();
});

await test('a resized character stays on screen and clear of its own furniture', () => {
  for (const size of [MIN_SIZE_PX, DEFAULT_SIZE_PX, MAX_SIZE_PX]) {
    const state = { engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000 };
    const { badge, root, document: doc, window: win } = mount({ state, sizePx: size });
    root.emit('pointerenter');
    const top = Number.parseFloat(root.style.top);
    const left = Number.parseFloat(root.style.left);
    assert.ok(top >= 0 && top + root.offsetHeight <= win.innerHeight, `size ${size} must fit vertically`);
    assert.ok(left >= 0 && left + root.offsetWidth <= win.innerWidth, `size ${size} must fit horizontally`);
    const bubbleTop = Number.parseFloat(bubbleOf(doc).style.top);
    const toolbarTop = Number.parseFloat(toolbarOf(doc).style.top);
    assert.ok(bubbleTop >= 0, `size ${size}: the bubble must stay on screen`);
    assert.ok(toolbarTop >= 0, `size ${size}: the toolbar must stay on screen`);
    badge.dispose();
  }
});

process.stdout.write('\nthe look\n');

await test('the panel header is brand blue in every state, including a grey-bead one', () => {
  // Reported: the tariff was off-peak and the whole bubble looked grey. The header dot and
  // the LIVE pill were drawn in the state's bead colour, and off-peak's bead is grey by
  // design — so the panel's own mark went grey too, which reads as "something is wrong"
  // rather than as "everything is cheap". The design fixes those two to brand blue; the
  // tariff's colour is carried by the row mark, where the design puts it.
  const offPeak = { engaged: false, heldCount: 0, overrideActive: false, phase: 'open' };
  const { badge, root, document: doc } = mount({ state: offPeak });
  root.emit('pointerenter');
  toolbarOf(doc).children[0].emit('click', { stopPropagation() {} });

  const header = bubbleOf(doc).children[0];
  const glow = header.children[0].children[0];
  const pill = header.children[1];
  assert.equal(beadLayer(doc, 'shell').style.background, '#8e9aa8', 'the bead is grey: the badge is doing nothing');
  // The mark is a solid core inside a soft halo, not one blurred dot: blurring the whole
  // thing read as out of focus rather than as glowing.
  const core = glow.children.find((child) => child.style.filter === undefined);
  const halo = glow.children.find((child) => child.style.filter !== undefined);
  assert.match(core.style.background, /brand-primary/u, 'the header mark is the panel colour, not the state colour');
  assert.match(halo.style.filter, /blur\(/u, 'and it has a halo rather than being blurred itself');
  assert.match(pill.style.color, /brand-primary/u);
  assert.equal(pill.textContent, 'LIVE');
  badge.dispose();
});

await test('a panel opened by hand closes itself again', async () => {
  // Reported: clicking status left the panel up for good. It is a glance, not a fixture —
  // and the lifetime is a setting, because "how long is enough to read this" is a
  // preference rather than a fact.
  const idle = { engaged: false, heldCount: 0, overrideActive: false, phase: 'open' };
  const { badge, root, document: doc } = mount({ state: idle, panelAutoHideMs: 60 });
  root.emit('pointerenter');
  toolbarOf(doc).children[0].emit('click', { stopPropagation() {} });
  assert.equal(bubbleOf(doc).style.display, 'block');

  await wait(220);
  assert.equal(bubbleOf(doc).style.display, 'none', 'it closes on its own');
  assert.equal(toolbarOf(doc).children[0].attributes['aria-pressed'], 'false', 'and the mark agrees');
  badge.dispose();
});

await test('a lifetime of zero leaves the panel up until it is closed by hand', async () => {
  const idle = { engaged: false, heldCount: 0, overrideActive: false, phase: 'open' };
  const { badge, root, document: doc } = mount({ state: idle, panelAutoHideMs: 0 });
  root.emit('pointerenter');
  toolbarOf(doc).children[0].emit('click', { stopPropagation() {} });
  await wait(150);
  assert.equal(bubbleOf(doc).style.display, 'block', 'zero means "leave it alone"');

  toolbarOf(doc).children[0].emit('click', { stopPropagation() {} });
  assert.equal(bubbleOf(doc).style.display, 'none', 'and a second click still closes it');
  badge.dispose();
});

await test('a panel reporting a hold is on the same clock as any other', async () => {
  // Reported: the display time was configured but the panel stayed up for the whole peak
  // window and had to be clicked away. An earlier version exempted a hold-reporting panel,
  // reasoning that it explains a situation and would vanish while the situation held — but
  // a situation lasts as long as the window does. It is a notification, not a fixture.
  const held = { engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' };
  const { badge, document: doc } = mount({ state: held, panelAutoHideMs: 60 });
  assert.equal(bubbleOf(doc).style.display, 'block', 'a hold shows the panel by itself');

  await wait(220);
  assert.equal(bubbleOf(doc).style.display, 'none', 'and it leaves on its own');
  badge.dispose();
});

await test('a dismissed panel comes back when the situation changes', async () => {
  // The other half of the same defect: nothing ever cleared the dismissal, so the first
  // click on the character silenced the badge for the rest of the session — a message held
  // an hour later produced no panel at all.
  // Mutated in place, not reassigned: `mount` reads `options.state`, so rebinding a local
  // would leave the badge reading the object it was mounted with.
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' };
  const { badge, root, document: doc } = mount({ state, panelAutoHideMs: 0 });
  assert.equal(bubbleOf(doc).style.display, 'block');

  bubbleOf(doc).emit('click', { stopPropagation() {} });
  assert.equal(bubbleOf(doc).style.display, 'none', 'dismissed');

  // A second message is withheld: same session, new news.
  state.heldCount = 2;
  badge.refresh();
  assert.equal(bubbleOf(doc).style.display, 'block', 'a new hold re-arms the panel');

  bubbleOf(doc).emit('click', { stopPropagation() {} });
  badge.refresh();
  assert.equal(bubbleOf(doc).style.display, 'none', 'but a poll that brings nothing new does not');
  root.emit('pointerenter');
  badge.dispose();
});

await test('the panel stays a panel even if the stylesheet never lands', () => {
  // The reported bug: label left, value right is the design's tidiest property, and it
  // was expressed only in the injected stylesheet — which this project cannot observe
  // being applied. A row that is a row only because a class said `display: flex` becomes
  // three stacked blocks the day the sheet does not apply. So the structure is inline
  // and this mounts into a document that refuses `<style>` outright.
  const document_ = createDocument();
  const appendChild = document_.body.appendChild.bind(document_.body);
  document_.body.appendChild = (child) => {
    if (child.tagName === 'style') throw new Error('this document refuses stylesheets');
    return appendChild(child);
  };
  const badge = mountBadge({
    document: document_,
    window: createWindow(),
    storage: createStorage(),
    art: ART,
    labels: {},
    readState: () => ({ engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' }),
    postAction: () => Promise.resolve({ ok: true }),
  });

  const row = bubbleOf(document_).children
    .flatMap((child) => child.children ?? [])
    .find((child) => String(child.className ?? '') === 'pvb-row');
  assert.notEqual(row, undefined, 'the panel must render its rows');
  assert.equal(row.style.display, 'flex');
  assert.equal(row.style.justifyContent, 'space-between', 'label hard left, value hard right');
  const value = row.children.find((child) => String(child.className ?? '').includes('pvb-row-value'));
  assert.equal(value.style.textAlign, 'right');
  assert.equal(row.children[0].style.whiteSpace, 'nowrap', 'and a long label must not wrap under the value');

  const tab = toolbarOf(document_).children[0];
  assert.equal(tab.style.display, 'flex');
  assert.equal(tab.style.flexDirection, 'column', 'the glyph sits above its label');
  assert.equal(tab.style.width, '70px');
  badge.dispose();
});

await test('the bead carries the state, and the panel row carries the tariff', () => {
  // Two axes, and the design draws both. The bead says what the *badge* is doing — blue
  // while it holds, because that is the plugin working. The panel's mark says what the
  // *tariff* is, where off-peak is green because cheap is the good state; reusing the
  // bead's grey here would have made "cheap" and "nothing happening" look the same.
  const held = { engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' };
  const { badge, document: doc } = mount({ state: held });
  assert.equal(beadLayer(doc, 'shell').style.background, '#007aff', 'a hold is the plugin working, so it is branded');
  assert.equal(beadLayer(doc, 'core').style.background, '#70c2ff');
  assert.match(beadLayer(doc, 'glow').style.width, /^\d+px$/u, 'the halo carries the intensity');

  const firstRow = bubbleOf(doc).children
    .flatMap((child) => child.children ?? [])
    .find((child) => String(child.className ?? '') === 'pvb-row');
  assert.notEqual(firstRow, undefined, 'the panel must render rows');
  const value = firstRow.children.find((child) => String(child.className ?? '').includes('pvb-row-value'));
  assert.equal(value.children.at(-1).style.color, 'var(--dsw-alias-brand-primary, #007aff)');
  assert.equal(value.children[0].style.background, '#007aff', 'peak is the active tariff, so it is branded too');
  badge.dispose();
});

await test('the bead and the panel mark answer different questions', () => {
  // An off-peak override: the bead is red because the badge is spending money, and the
  // tariff mark is green because the tariff is the cheap one. Two axes on screen at
  // once, which is exactly the case that would collapse if they shared a colour.
  const { badge, document: doc } = mount({
    state: { engaged: false, heldCount: 0, overrideActive: true, overrideUntilMs: Date.now() + 60_000, phase: 'open' },
  });
  assert.equal(beadLayer(doc, 'shell').style.background, '#ff3b30', 'the costly state, on the bead');
  const firstRow = bubbleOf(doc).children
    .flatMap((child) => child.children ?? [])
    .find((child) => String(child.className ?? '') === 'pvb-row');
  assert.notEqual(firstRow, undefined, 'an override shows the panel');
  assert.equal(
    firstRow.children.find((child) => String(child.className ?? '').includes('pvb-row-value')).children[0].style.background,
    '#34c759',
    'and the cheap tariff, on the row',
  );
  badge.dispose();
});

await test('the halo is what carries intensity', () => {
  const quiet = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
  const busy = mount({ state: { engaged: true, heldCount: 2, releaseAtMs: Date.now() + 3_600_000 } });
  const width = (mounted) => Number.parseFloat(beadLayer(mounted.document, 'glow').style.width);
  assert.ok(width(busy) > width(quiet), 'a state worth acting on must be more visible than an idle one');
  quiet.badge.dispose();
  busy.badge.dispose();
});

await test('a live override gets the one alarming colour', () => {
  // Everything else is either quiet or the plugin working as intended; deliberately
  // spending money at peak is the only state that earns the warning colour.
  const calm = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
  const loud = mount({ state: { engaged: false, heldCount: 0, overrideActive: true, overrideUntilMs: Date.now() + 60_000 } });
  assert.equal(beadLayer(loud.document, 'shell').style.background, '#ff3b30');
  assert.ok(
    Number.parseFloat(beadLayer(loud.document, 'glow').style.width) >
      Number.parseFloat(beadLayer(calm.document, 'glow').style.width),
    'and it glows hardest of all',
  );
  calm.badge.dispose();
  loud.badge.dispose();
});

await test('the stylesheet is injected once and outlives any one mount', () => {
  // It used to be removed on dispose, which meant the first mount to go away stripped
  // the styling from a second mount that was still on screen and sharing it. It is
  // inert and the module system collects a factory's style tags when the plugin
  // unloads, which is when they are actually finished with.
  const document_ = createDocument();
  const options = {
    document: document_,
    window: createWindow(),
    storage: createStorage(),
    art: ART,
    labels: {},
    readState: () => undefined,
    postAction: () => Promise.resolve({ ok: true }),
  };
  const first = mountBadge(options);
  const second = mountBadge(options);
  const styles = () => document_.body.children.filter((child) => child.tagName === 'style');
  assert.equal(styles().length, 1, 'a re-mount must reuse the stylesheet, not stack a second copy');
  first.dispose();
  assert.equal(styles().length, 1, 'the mount still on screen must keep its styling');
  second.dispose();
  assert.equal(styles().length, 1, 'and the tag itself is inert once nothing is using it');
});

await test('the stylesheet switches its motion off on request', async () => {
  // The character breathes and the panels rise. That is pleasant once and irritating
  // forever to someone who has asked their system for less movement.
  const source = await readFile(new URL('../lib/badge-mount.js', import.meta.url), 'utf8');
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(source, /@keyframes pvb-breathe/u);
  assert.match(source, /@keyframes pvb-pop/u);
});

await test('the bar offers four tabs, each an icon over its label', () => {
  // The design's tab: an 18px glyph above a 10px label, in a pill. The icon is a mask
  // so that one SVG serves both the selected and the unselected state, taking its
  // colour from the tab's own text colour.
  const held = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' };
  const { badge, root, document: doc } = mount({ state: held });
  root.emit('pointerenter');
  const tabs = toolbarOf(doc).children;
  assert.equal(tabs.length, 4);

  for (const tab of tabs) {
    assert.ok(tab.className.includes('pvb-tab'), 'every tab needs the class its states hang off');
    const icon = tab.children.find((child) => String(child.className ?? '') === 'pvb-tab-icon');
    const label = tab.children.find((child) => String(child.className ?? '') === 'pvb-tab-label');
    assert.notEqual(icon, undefined, 'each tab has a glyph');
    assert.notEqual(label, undefined, 'each tab has a label');
    assert.match(icon.style.maskImage, /^url\("data:image\/svg\+xml,/u, 'the glyph is a mask, so it takes the colour');
    // The colour itself is `currentColor`, so one glyph serves the selected and the
    // unselected tab, and it is inline because the glyph's size is structure.
    assert.equal(icon.style.backgroundColor, 'currentColor');
    assert.equal(icon.style.maskSize, 'contain');
  }
  assert.deepEqual(
    tabs.map((tab) => tab.children.find((child) => String(child.className ?? '') === 'pvb-tab-label').textContent),
    ['status', 'now', 'window', 'cancel'],
  );
  badge.dispose();
});

await test('exactly one tab reads as the selected one, and it is the one that always works', () => {
  // The design marks one tab with a lighter pill and the brand colour, and it is the
  // status tab — which is also the only operation that can never be unavailable, so the
  // mark is always on something that works.
  const held = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' };
  const { badge, root, document: doc } = mount({ state: held });
  root.emit('pointerenter');
  const tabs = toolbarOf(doc).children;
  const pressed = tabs.filter((tab) => tab.attributes['aria-pressed'] === 'true');
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].children.find((child) => String(child.className ?? '') === 'pvb-tab-label').textContent, 'status');
  assert.match(pressed[0].style.color, /brand-primary/u, 'and it is the one drawn in the brand colour');
  assert.equal(pressed[0].disabled, false, 'the selected tab is never a dead one');

  const others = tabs.filter((tab) => tab.attributes['aria-pressed'] === 'false');
  assert.equal(others.length, 3);
  for (const tab of others) assert.match(tab.style.color, /label-secondary/u);
  badge.dispose();
});

await test('the status tab opens the panel instead of printing a paragraph about it', () => {
  // The reported bug. Clicking status asked the host for the `/peak-valley status` text
  // and printed it — a left-aligned paragraph about exactly the facts the panel draws as
  // a dashboard — so the one tab the design highlights produced something that looked
  // nothing like the design. It now pins the panel open, with no round trip at all.
  const idle = { engaged: false, heldCount: 0, overrideActive: false, phase: 'open' };
  const { badge, root, document: doc, posted } = mount({ state: idle });
  assert.equal(bubbleOf(doc).style.display, 'none', 'nothing is happening, so the panel is away');

  root.emit('pointerenter');
  // The bar is rebuilt on every render, so each reading has to re-query it: holding a
  // reference across a click reads a detached node and asserts the previous state.
  toolbarOf(doc).children[0].emit('click', { stopPropagation() {} });

  assert.equal(bubbleOf(doc).style.display, 'block', 'the panel is now open');
  assert.equal(posted.length, 0, 'and the host was not asked for a paragraph');
  const rows = bubbleOf(doc).children
    .flatMap((child) => child.children ?? [])
    .filter((child) => String(child.className ?? '') === 'pvb-row');
  assert.equal(rows.length, 6, 'the pin shows the designed panel, not text');
  assert.equal(toolbarOf(doc).children[0].attributes['aria-pressed'], 'true', 'and the mark says the panel is open');

  toolbarOf(doc).children[0].emit('click', { stopPropagation() {} });
  assert.equal(bubbleOf(doc).style.display, 'none', 'clicking again puts it away');
  assert.equal(toolbarOf(doc).children[0].attributes['aria-pressed'], 'false');
  badge.dispose();
});

await test('the release tabs still ask the host and show its answer in words', () => {
  // Their answers are prose — a confirmation, a refusal — and prose is what the bubble
  // shows. Only the status tab had a designed alternative.
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 3_600_000, phase: 'peak' };
  const { badge, root, document: doc, posted } = mount({ state });
  root.emit('pointerenter');
  const tabs = toolbarOf(doc).children;
  tabs[1].emit('click', { stopPropagation() {} });
  assert.deepEqual(posted, ['now']);
  badge.dispose();
});

await test('an unavailable action stays visible and explains itself', () => {
  // The bar doubles as the explanation of the current state, so an operation that
  // does not apply is dimmed rather than removed — removing it would remove the
  // explanation, and its tooltip with it.
  const { badge, root, document: doc } = mount({ state: { engaged: false, heldCount: 0, overrideActive: false } });
  root.emit('pointerenter');
  const tabs = toolbarOf(doc).children;
  assert.equal(tabs.length, 4, 'all four operations keep their place');
  const disabled = tabs.filter((tab) => tab.disabled);
  assert.equal(disabled.length, 3);
  for (const tab of disabled) {
    const label = tab.children.find((child) => String(child.className ?? '') === 'pvb-tab-label').textContent;
    assert.ok(tab.title !== '', `${label} must say why it is unavailable`);
    assert.equal(tab.attributes['aria-pressed'], 'false', 'and none of them may claim to be the current action');
  }
  badge.dispose();
});

process.stdout.write('\nplacement and teardown\n');

await test('the badge is placed inside the viewport', () => {
  const { badge, root, window: win } = mount();
  const left = Number.parseFloat(root.style.left);
  const top = Number.parseFloat(root.style.top);
  assert.ok(Number.isFinite(left) && Number.isFinite(top));
  assert.ok(left >= 0 && left + root.offsetWidth <= win.innerWidth);
  assert.ok(top >= 0 && top + root.offsetHeight <= win.innerHeight);
  badge.dispose();
});

await test('dragging moves the badge and remembers where it was put', () => {
  const { badge, root, storage } = mount();
  root.emit('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  root.emit('pointermove', { clientX: 300, clientY: 400 });
  root.emit('pointerup', {});
  const stored = readPreferences(storage).position;
  assert.ok(stored !== undefined, 'a dragged badge must come back where it was left');
  assert.equal(Number.parseFloat(root.style.left), stored.x);
  badge.dispose();
});

await test('a drag is not mistaken for a click', () => {
  const state = { engaged: true, heldCount: 1, releaseAtMs: Date.now() + 60_000 };
  const { badge, root, document: doc } = mount({ state });
  root.emit('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
  root.emit('pointermove', { clientX: 60, clientY: 60 });
  root.emit('pointerup', {});
  assert.notEqual(bubbleOf(doc).style.display, 'none', 'dragging must not toggle the bubble');
  badge.dispose();
});

await test('a hostile storage does not stop the badge appearing', () => {
  const document_ = createDocument();
  const badge = mountBadge({
    document: document_,
    window: createWindow(),
    storage: {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    },
    art: ART,
    labels: {},
    readState: () => undefined,
    postAction: () => Promise.resolve({ ok: true }),
  });
  assert.ok(document_.body.children.some((child) => child.id === 'peak-valley-brake-badge'));
  assert.doesNotThrow(() => badge.showNotice('x'));
  assert.doesNotThrow(() => badge.dispose());
});

await test('dispose removes every element it showed, leaving only the inert stylesheet', () => {
  const { badge, body } = mount();
  assert.ok(body.children.length > 0);
  badge.dispose();
  const remaining = body.children.filter((child) => child.tagName !== 'style');
  assert.equal(remaining.length, 0, 'a disposed badge must not leave anything visible in the page');
  assert.equal(body.children.length, 1, 'the stylesheet is the only thing that stays, by design');
});

await test('re-mounting replaces the previous badge instead of stacking one', () => {
  const document_ = createDocument();
  const options = {
    document: document_,
    window: createWindow(),
    storage: createStorage(),
    art: ART,
    labels: {},
    readState: () => undefined,
    postAction: () => Promise.resolve({ ok: true }),
  };
  const first = mountBadge(options);
  const second = mountBadge(options);
  assert.equal(document_.body.children.filter((child) => child.id === 'peak-valley-brake-badge').length, 1);
  first.dispose();
  second.dispose();
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
