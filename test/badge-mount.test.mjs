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

import { mountBadge, readPreferences, writePreferences } from '../lib/badge-mount.js';

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
    /** Fixed size: the badge reads these to place itself. */
    get offsetWidth() {
      return 77;
    },
    get offsetHeight() {
      return 96;
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
  const storage = createStorage();
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
  });
  const root = document_.body.children.find((child) => child.id === 'peak-valley-brake-badge');
  const bubble = document_.body.children.find((child) => child !== root && child.style.borderRadius === '10px' && child.tagName === 'div' && child.children.length >= 0 && child !== root);
  return { document: document_, window: window_, storage, badge, root, bubble, posted, body: document_.body };
}

/** The bubble is the element that gets a min-width; the toolbar gets a flex display. */
function bubbleOf(document_) {
  return document_.body.children.find((child) => child.style.minWidth === '150px');
}

/** The toolbar is the element whose display is toggled to flex. */
function toolbarOf(document_) {
  return document_.body.children.find((child) => child.style.gap === '4px');
}

process.stdout.write('peak-valley-brake badge mounting\n\n');

process.stdout.write('what it draws\n');

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

await test('the toolbar is hidden until the pointer arrives', () => {
  const { badge, root, document: doc } = mount();
  assert.equal(toolbarOf(doc).style.display, 'none');
  root.emit('pointerenter');
  assert.equal(toolbarOf(doc).style.display, 'flex');
  root.emit('pointerleave');
  assert.equal(toolbarOf(doc).style.display, 'none');
  badge.dispose();
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

await test('dispose removes every element it added', () => {
  const { badge, body } = mount();
  assert.ok(body.children.length > 0);
  badge.dispose();
  assert.equal(body.children.length, 0, 'a disposed badge must not leave orphans in the page');
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
