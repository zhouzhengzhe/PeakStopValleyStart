/**
 * Client-plugin entry: read the brake's state, mount the badge, offer its settings.
 *
 * This module is the *source* of the client bundle, not the bundle itself. The
 * harness serves a single file that calls `window.__ModuleLoader__.load({
 * factory })`, so `scripts/build-client.mjs` bundles this module and wraps it in
 * that call. Keeping the wrapper generated means the entry can use ordinary
 * relative imports instead of being hand-written around a loader call.
 *
 * ## What this half does and does not read
 *
 * The badge's *state* comes from the host over the route this plugin owns. Not
 * because the browser lacks services — it has `slots`, `settingsScope`,
 * `connection`, `locale`, `theme` and more — but because the projection registry
 * and the session registry are host-side, and because the host is the only side
 * that knows which session the operator is looking at.
 *
 * An earlier version of this file claimed the client half provided no session or
 * projection service and concluded `inject` should be empty. The premise was true
 * as far as it went — neither of those two is client-side — but the conclusion was
 * wrong twice over: `slots` and `settingsScope` *are* provided, and they are
 * exactly what a settings page needs. What survives is the narrower rule: declare
 * a service only when a provider exists, and declare it optionally, because a
 * client plugin whose injected service never arrives is parked until it does and
 * never activates at all.
 *
 * @module peak-valley-brake/client
 */

import { mountBadge } from './badge-mount.js';
import { MASCOT_ART } from './mascot-data.js';
import { SETTINGS_NAMESPACE, normalizeBadgeSettings } from './badge-settings.js';
import { registerSettingsSection } from './badge-settings-section.js';

/**
 * Re-exported so the plugin's client surface is the whole of what the bundle
 * offers. The loader copies this module's exports and nothing else, so a symbol
 * that is only imported stays private to the bundle — which is how the settings
 * page came to exist, work, and be unreachable from anything testing it.
 */
export { SECTION_ID, SECTION_LABEL, SECTION_ORDER, createSettingsSection, registerSettingsSection } from './badge-settings-section.js';

export const name = 'peak-valley-brake';

/**
 * Services this client plugin reads.
 *
 * Both optional, and both real: `slots` is provided by the renderer's slot
 * registry and `settingsScope` by the settings UI. Nullish values mark them
 * optional, so a composition without the settings surface still mounts the badge —
 * the settings page and the badge are independent features, and losing one must
 * not cost the other.
 */
export const inject = { slots: null, settingsScope: null };

/** How often the badge asks the host for the current state. */
export const POLL_INTERVAL_MS = 2500;

/** How long a command's answer stays in the bubble, in milliseconds. */
export const NOTICE_MS = 8000;

/**
 * The exact path the badge's buttons post to.
 *
 * Declared here as well as in the host module on purpose: the two halves ship
 * separately and a typo in either would 404 at runtime, which is exactly the kind
 * of failure a browser would surface only to a human. `test/badge-api.test.mjs`
 * asserts the host constant; this one is asserted by the client bundle test.
 */
const ACTION_PATH = '/api/peak-valley-brake.action';

/**
 * Create the badge's connection to the host.
 *
 * Returned as an object rather than closed over inside `apply` so the whole read
 * and act path can be driven in Node — the part of this half that can be verified
 * without a browser.
 *
 * @param {object} [deps] - injectable collaborators, for tests.
 * @param {typeof fetch} [deps.fetchImpl] - the fetch to use.
 * @returns {{read: () => object|undefined, sessionId: () => string|undefined, request: (action: string) => Promise<object|undefined>}} the controller.
 */
export function createController(deps = {}) {
  const doFetch = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  let latest;
  let sessionId;

  /**
   * Post one action and fold the answer into local state.
   *
   * Every failure returns undefined rather than throwing: the badge runs inside
   * the operator's page, and a transient network error must cost a stale pose,
   * never an exception in a render path.
   *
   * @param {string} action - one of the endpoint's actions.
   * @returns {Promise<object|undefined>} the response body, when one arrived.
   */
  const request = async (action) => {
    let body;
    try {
      const response = await doFetch(ACTION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionId === undefined ? { action } : { action, sessionId }),
      });
      body = await response.json();
    } catch {
      return undefined;
    }
    if (body === null || typeof body !== 'object') return undefined;

    // The host resolves the session on the first poll and hands it back, so the
    // browser learns which session it is describing without ever guessing. A
    // later 404 keeps the id: the agent may simply not be live yet.
    if (typeof body.sessionId === 'string' && body.sessionId !== '') sessionId = body.sessionId;
    if (body.state !== undefined && body.state !== null) latest = body.state;
    return body;
  };

  return { read: () => latest, sessionId: () => sessionId, request };
}

/**
 * Read a service without letting its absence throw into the caller.
 *
 * @param {object} ctx - client plugin context.
 * @param {string} key - service name.
 * @returns {object|undefined} the service, when resolvable.
 */
function probe(ctx, key) {
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

/**
 * Bind the badge's settings namespace, when the settings surface is present.
 *
 * @param {object} ctx - client plugin context.
 * @returns {object|undefined} the namespace's scope.
 */
function bindSettingsScope(ctx) {
  const settings = probe(ctx, 'settingsScope');
  if (settings === undefined || typeof settings.bind !== 'function') return undefined;
  try {
    return settings.bind({ namespace: SETTINGS_NAMESPACE });
  } catch {
    return undefined;
  }
}

/**
 * Install the badge and its settings page.
 *
 * @param {object} ctx - client plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const controller = createController();
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* one bad listener must not stop the others */
      }
    }
  };

  let badge;
  let timer;
  let latestSettings;

  /** Push the settings plane's values onto the mounted badge. */
  const applySettings = () => {
    if (badge === undefined || latestSettings === undefined) return;
    badge.setVisible(latestSettings.badgeVisible);
    badge.setSize(latestSettings.badgeSize, { remember: false });
    badge.setHoverGrace(latestSettings.hoverDelayMs);
  };

  const settingsScope = bindSettingsScope(ctx);
  if (settingsScope !== undefined && typeof settingsScope.subscribe === 'function') {
    const sync = () => {
      let snapshot;
      try {
        snapshot = settingsScope.getSnapshot();
      } catch {
        return;
      }
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.status !== 'ready') return;
      latestSettings = normalizeBadgeSettings(snapshot.value);
      applySettings();
    };
    try {
      settingsScope.subscribe(sync);
      sync();
    } catch {
      /* a settings surface that misbehaves must not stop the badge appearing */
    }
  }

  const start = () => {
    const doc = globalThis.document;
    if (doc?.body === undefined) return;

    badge = mountBadge({
      document: doc,
      window: globalThis,
      storage: safeStorage(),
      art: MASCOT_ART,
      labels: LABELS,
      readState: () => controller.read(),
      postAction: async (action) => {
        const body = await controller.request(action);
        if (typeof body?.text === 'string' && body.text !== '') {
          badge?.showNotice(body.text, NOTICE_MS);
        }
        return body;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    // The settings may have arrived before there was a badge to apply them to.
    applySettings();

    // Poll rather than subscribe. The host publishes to a projection the client
    // half cannot reach, and this state is a handful of fields: a request every
    // few seconds is cheaper than the machinery a push channel would need.
    void controller.request('poll').then(notify);
    timer = setInterval(() => {
      void controller.request('poll').then(notify);
    }, POLL_INTERVAL_MS);
  };

  if (globalThis.document?.body !== undefined) {
    start();
  } else {
    // Applying before the shell has a body is unusual but not impossible; waiting
    // for the parse to finish is strictly better than not mounting at all.
    globalThis.document?.addEventListener?.('DOMContentLoaded', start, { once: true });
  }

  // Registered whether or not the badge mounted: the settings page is the way back
  // to a badge that has been hidden, so hiding it must not remove the page.
  registerSettingsSection(ctx, { scope: settingsScope });

  void timer;
}

/**
 * Reach localStorage without letting a hostile store break the badge.
 * @returns {Storage|undefined} the store, when usable.
 */
function safeStorage() {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Text the badge shows. Chinese, matching the rest of this plugin's messages. */
const LABELS = Object.freeze({
  alt: '峰谷刹车状态',
  held: '已拦截',
  count: '条',
  autoRelease: '自动放行',
  armed: '即将进入峰时',
  override: '已按峰价放行',
  cancelHint: '/peak-valley cancel 可撤销',
  hover: '悬停看操作',
  status: '状态',
  now: '放行一次',
  window: '放行到谷时',
  cancel: '撤销覆盖',
  peakOnly: '当前不是峰时，无需放行',
  nothingHeld: '当前没有滞留消息',
  noOverride: '当前没有生效的覆盖',
  costsPeak: '会按峰价持续计费',
});
