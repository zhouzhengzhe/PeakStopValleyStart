/**
 * Client-plugin entry: read the brake's state and mount the badge.
 *
 * This module is the *source* of the client bundle, not the bundle itself. The
 * harness serves a single file that calls `window.__ModuleLoader__.load({
 * factory })`, so `scripts/build-client.mjs` bundles this module and wraps it in
 * that call. Keeping the wrapper generated means the entry can use ordinary
 * relative imports instead of being hand-written around a loader call.
 *
 * ## Why this half declares no services
 *
 * The obvious design is to read the projection directly: `sessionProjections`
 * exposes exactly the state the badge draws. On this side of the wire that
 * service does not exist — the client half of the harness provides `connection`,
 * `locale`, `theme`, `chatFileMentions`, `sessionLogDownload` and the cordis
 * runner's own pair, and nothing else. A client plugin that declares a service
 * nobody provides is parked until it appears, so it never activates at all: the
 * failure is a badge that silently never mounts, with no error anywhere.
 *
 * So the badge asks the host instead, over the one route this plugin already
 * owns. The host has both services, and it is the only side that knows which
 * session the operator is looking at. That also removes the guesswork: `inject`
 * is empty by construction, and every read is a request that either answers or
 * fails softly.
 *
 * @module peak-valley-brake/client
 */

import { mountBadge } from './badge-mount.js';
import { MASCOT_ART } from './mascot-data.js';

export const name = 'peak-valley-brake';

/**
 * Services this client plugin reads.
 *
 * Deliberately empty. Declaring one is a promise that this harness provides it,
 * and a promise the client half cannot keep is a badge that never appears — see
 * the module comment. Nothing here is needed: the state arrives over HTTP.
 */
export const inject = [];

/** The projection key the host publishes under, kept for cross-half assertions. */
const PROJECTION_KEY = 'peakValleyBrake';

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
 * Install the badge.
 *
 * @param {object} ctx - client plugin context. Unused, and accepted so the shape
 *   matches what the harness calls; keeping the parameter documents that this
 *   half deliberately reads nothing from it.
 * @returns {void}
 */
export function apply(ctx) {
  void ctx;
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
    return;
  }
  // Applying before the shell has a body is unusual but not impossible; waiting
  // for the parse to finish is strictly better than not mounting at all.
  globalThis.document?.addEventListener?.('DOMContentLoaded', start, { once: true });
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

/** Exported for the bundle test, which checks the key against the host module. */
export { PROJECTION_KEY, ACTION_PATH };
