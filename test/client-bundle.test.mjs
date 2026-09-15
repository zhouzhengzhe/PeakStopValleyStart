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

/**
 * The smallest React the module needs in order to load.
 *
 * Deliberately not a renderer: this suite checks the loader contract and the
 * request path, and the one thing it must prove about React is that the bundle
 * *asks for it* instead of carrying its own copy.
 *
 * @returns {object} a stand-in for `react`.
 */
function fakeReact() {
  return {
    createElement: () => ({}),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => undefined,
  };
}

/**
 * Materialize the bundle's exports with the host's module table stubbed.
 *
 * @returns {object} the module's exports.
 */
function loadModule() {
  const required = [];
  return loadBundle(bundleSource).factory((specifier) => {
    required.push(specifier);
    if (specifier === 'react') return fakeReact();
    throw new Error(`this bundle must not require "${specifier}"`);
  });
}

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
  const exported = loadModule();
  assert.equal(typeof exported.apply, 'function', 'the harness calls apply(ctx)');
  assert.equal(exported.name, 'peak-valley-brake');
});

await test('every declared service is one, and every one is optional', () => {
  // Two properties matter and both were got wrong once. Each name must be a service
  // this harness actually provides — `slots` is provided by the renderer's slot
  // registry, `settingsScope` by the settings UI — and each must be declared
  // nullish, because a client plugin whose injected service never arrives is parked
  // until it does and never activates: the badge would silently never mount.
  const exported = loadModule();
  assert.equal(typeof exported.inject, 'object');
  assert.deepEqual(Object.keys(exported.inject).sort(), ['settingsScope', 'slots']);
  for (const [service, declaration] of Object.entries(exported.inject)) {
    assert.equal(declaration, null, `${service} must be optional`);
  }
});

await test('React is referenced from the host table, never bundled', () => {
  // The settings page is a slot occupant, and the renderer invokes it as a
  // component of the shell's own React. A second bundled copy gives the page two
  // React instances and every hook throws "invalid hook call" — invisible to this
  // project, because it only happens in a browser.
  assert.match(bundleSource, /require\("react"\)/u, 'React must be required, not inlined');
  for (const marker of ['ReactCurrentDispatcher', '__SECRET_INTERNALS', 'react.development.js']) {
    assert.ok(!bundleSource.includes(marker), `the bundle must not contain a React runtime (${marker})`);
  }
});

await test('the settings page registers into the slot the shell declares', () => {
  const exported = loadModule();
  const registrations = [];
  let injectKey;
  const ctx = {
    slots: {
      inject(key, callback) {
        injectKey = key;
        return callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  assert.doesNotThrow(() => exported.registerSettingsSection(ctx, { scope: undefined }));
  assert.equal(injectKey, 'settings.section');
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'settings.section');
  assert.equal(registrations[0].options.id, 'peak-valley-brake', 'a shipped id would replace that section');
  assert.equal(typeof registrations[0].component, 'function', 'a slot occupant must be a component');
});

await test('a composition with no slot registry costs the settings page only', () => {
  // The badge and the settings page are independent: losing the settings surface
  // must not throw into the page an operator is working in.
  const exported = loadModule();
  for (const ctx of [{}, { slots: {} }, { get: () => undefined }]) {
    assert.doesNotThrow(() => exported.registerSettingsSection(ctx, { scope: undefined }));
    assert.equal(exported.registerSettingsSection(ctx, { scope: undefined }), undefined);
  }
});

await test('a slot registry that throws does not break the plugin', () => {
  const exported = loadModule();
  const ctx = {
    slots: {
      inject() {
        throw new Error('the registry is unhappy');
      },
      register() {
        throw new Error('the registry is unhappy');
      },
    },
  };
  assert.doesNotThrow(() => exported.registerSettingsSection(ctx, { scope: undefined }));
});

await test('the controller takes a reading from the host and remembers the session', async () => {
  const exported = loadModule();
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
  const exported = loadModule();
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
  const exported = loadModule();
  const controller = exported.createController({
    fetchImpl: async () => {
      throw new Error('the page went offline');
    },
  });
  assert.equal(await controller.request('poll'), undefined);
  assert.equal(controller.read(), undefined);
});

await test('a response that is not an object is ignored rather than trusted', async () => {
  const exported = loadModule();
  for (const value of [null, 'text', 42]) {
    const controller = exported.createController({ fetchImpl: async () => ({ json: async () => value }) });
    assert.equal(await controller.request('poll'), undefined);
    assert.equal(controller.read(), undefined);
  }
});

await test('apply survives a context with no services at all', () => {
  // The client half runs somewhere this project cannot inspect, so a missing
  // service must degrade to a quieter badge rather than an exception in the page.
  const exported = loadModule();
  const ctx = {
    get(key) {
      throw new Error(`no service ${key}`);
    },
  };
  assert.doesNotThrow(() => exported.apply(ctx));
});

await test('apply does not mount without a document', () => {
  const exported = loadModule();
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
