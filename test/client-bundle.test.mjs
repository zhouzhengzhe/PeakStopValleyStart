/**
 * Self-check that the built client bundle honours the loader contract.
 *
 * Run with `node test/client-bundle.test.mjs`.
 *
 * The bundle is generated, committed, and executed by a browser this project
 * cannot open. So it is loaded here instead, against a stub of the one global it
 * touches, and its contract is asserted: the loader call, the module id, the
 * exported shape the harness looks for, and that the inlined art actually reached
 * the bundle rather than being tree-shaken away.
 *
 * That leaves exactly one unverified property — what it looks like — which is a
 * far better place to stop than "it built without errors".
 *
 * @module peak-valley-brake/test/client-bundle
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundlePath = join(root, 'lib', 'client.bundle.js');

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

/**
 * Execute the bundle against a stub loader and return what it registered.
 *
 * The bundle is an IIFE that expects exactly one global: the module loader. A
 * fresh vm context with that stub is therefore enough to run it, and running it
 * is the only way to know the wrapper is well-formed.
 *
 * @param {string} source - the bundle source.
 * @returns {{id: string, factory: Function}} the registration.
 */
function loadBundle(source) {
  let registered;
  runInNewContext(
    source,
    {
      window: {
        __ModuleLoader__: {
          load(registration) {
            registered = registration;
          },
        },
      },
      console,
    },
    { filename: 'client.bundle.js' },
  );
  assert.ok(registered !== undefined, 'the bundle must call window.__ModuleLoader__.load');
  return registered;
}

const bundleSource = await readFile(bundlePath, 'utf8');

process.stdout.write('peak-valley-brake client bundle\n\n');

await test('the bundle exists and carries the inlined art', () => {
  assert.ok(bundleSource.length > 50_000, 'the bundle looks too small to contain the art');
  assert.ok(bundleSource.includes('data:image/png;base64,'), 'the art must be inlined, not referenced');
});

await test('the bundle registers itself under this plugin id', () => {
  const registration = loadBundle(bundleSource);
  assert.equal(registration.id, 'dsh-peak-valley-brake');
  assert.equal(typeof registration.factory, 'function');
});

await test('the factory exports what the harness looks for', () => {
  const registration = loadBundle(bundleSource);
  const exported = registration.factory(() => {
    throw new Error('this bundle must not require a shared module');
  });
  assert.equal(typeof exported.apply, 'function', 'the harness calls apply(ctx)');
  assert.ok(Array.isArray(exported.inject), 'the harness reads inject to resolve services');
  assert.equal(exported.name, 'peak-valley-brake');
});

await test('the declared client services are ones this harness actually provides', () => {
  // The client half provides `connection`, `locale`, `theme`, `chatFileMentions`,
  // `sessionLogDownload` and the cordis runner's own pair — and no session or
  // projection registry. A client plugin that declares a service nobody provides
  // is parked until it appears, so it never activates and the badge silently never
  // mounts. The state therefore travels over the host route, and this list is
  // empty on purpose. `connection` is the only name that would even be legal.
  const exported = loadBundle(bundleSource).factory(() => ({}));
  assert.deepEqual([...exported.inject], []);
});

await test('the controller takes a reading from the host and remembers the session', async () => {
  const exported = loadBundle(bundleSource).factory(() => ({}));
  const sent = [];
  const controller = exported.createController({
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return {
        json: async () => ({
          ok: true,
          kind: 'state',
          text: '',
          sessionId: 'session-7',
          state: { engaged: true, heldCount: 2 },
        }),
      };
    },
  });

  assert.equal(controller.read(), undefined, 'nothing is known before the first reading');
  const body = await controller.request('poll');
  assert.equal(body.ok, true);
  assert.equal(controller.sessionId(), 'session-7', 'the host names the session; the browser never guesses');
  assert.deepEqual(controller.read(), { engaged: true, heldCount: 2 });
  assert.equal(sent[0].url, '/api/peak-valley-brake.action');
  assert.deepEqual(sent[0].body, { action: 'poll' }, 'the first request cannot name a session');
});

await test('a later request sends back the session the host named', async () => {
  const exported = loadBundle(bundleSource).factory(() => ({}));
  const sent = [];
  const controller = exported.createController({
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { json: async () => ({ ok: true, sessionId: 'session-7' }) };
    },
  });
  await controller.request('poll');
  await controller.request('now');
  assert.deepEqual(sent[1], { action: 'now', sessionId: 'session-7' });
});

await test('a failing request costs a stale pose, never an exception', async () => {
  const exported = loadBundle(bundleSource).factory(() => ({}));
  const controller = exported.createController({
    fetchImpl: async () => {
      throw new Error('the page went offline');
    },
  });
  assert.equal(await controller.request('poll'), undefined);
  assert.equal(controller.read(), undefined);
});

await test('a response that is not an object is ignored rather than trusted', async () => {
  const exported = loadBundle(bundleSource).factory(() => ({}));
  for (const value of [null, 'text', 42]) {
    const controller = exported.createController({ fetchImpl: async () => ({ json: async () => value }) });
    assert.equal(await controller.request('poll'), undefined);
    assert.equal(controller.read(), undefined);
  }
});

await test('apply survives a context with no services at all', () => {
  // The client half runs somewhere this project cannot inspect, so a missing
  // service must degrade to a quieter badge rather than an exception in the page.
  const exported = loadBundle(bundleSource).factory(() => ({}));
  const ctx = {
    get(key) {
      throw new Error(`no service ${key}`);
    },
  };
  assert.doesNotThrow(() => exported.apply(ctx));
});

await test('apply does not mount without a document', () => {
  const exported = loadBundle(bundleSource).factory(() => ({}));
  assert.doesNotThrow(() => exported.apply({}));
});

await test('the action path in the bundle matches the host endpoint', async () => {
  // The two halves ship separately and a mismatch is a 404 only a human would
  // see, so the literal is compared against the host module's constant.
  const host = await import('../lib/badge-api.js');
  assert.ok(
    bundleSource.includes(host.BADGE_ACTION_PATH),
    `the bundle must post to ${host.BADGE_ACTION_PATH}`,
  );
});

await test('the art for every state reached the bundle', async () => {
  const { MASCOT_ART } = await import('../lib/mascot-data.js');
  assert.deepEqual(Object.keys(MASCOT_ART).sort(), ['armed', 'held', 'idle', 'released']);
  for (const state of Object.keys(MASCOT_ART)) {
    assert.ok(MASCOT_ART[state].startsWith('data:image/png;base64,'), `${state} must be a PNG data URI`);
  }
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
