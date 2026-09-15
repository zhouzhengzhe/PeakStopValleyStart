/**
 * Static assembly check: the manifest, the bundle patch, and the module must
 * agree with each other before the host ever loads them.
 *
 * Run with `node test/manifest.test.mjs`.
 *
 * Why this exists: every failure it catches is one the host can only report as a
 * refused profile boot, long after the mistake was made and far from its cause.
 * A patch row naming a specifier the loader cannot resolve, a `dsh.bundle` field
 * pointing at a file that is not shipped, or a module that does not export the
 * frozen `{ name, Config, apply }` shape are all silent until runtime.
 *
 * @module peak-valley-brake/test/manifest
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
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

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const module_ = await import('../lib/index.js');

process.stdout.write('peak-valley-brake assembly\n\n');

await test('the manifest declares a bundle patch and points at a real file', async () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  const contents = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(contents.length > 0);
});

await test('the client declaration names a platform the module system accepts', () => {
  assert.equal(typeof manifest.dsh?.client?.platform, 'string');
  assert.equal(manifest.dsh.client.platform, 'web', 'the desktop shell serves the web platform');
});

await test('the client declaration names the packages its settings page comes from', () => {
  // `dsh.client.inject` is a list of *package* ids to arrive before this bundle —
  // module ordering, not cordis services, which the client module declares itself
  // in its own `inject` export. The ordering matters here: the settings page
  // registers into a slot the settings shell declares while it mounts.
  assert.deepEqual([...manifest.dsh.client.inject].sort(), [
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-general',
  ]);
});

await test('the client export points at the built bundle, not the ESM source', () => {
  // The harness serves whatever `exports["./client"]` names straight to a browser
  // as a classic script. Pointing it at the ESM source would serve `import`
  // statements to a page that cannot resolve them, and the bundle would never
  // call `__ModuleLoader__.load`: the badge would simply never appear, with no
  // error a human would connect to this field.
  assert.equal(manifest.exports?.['./client'], './lib/client.bundle.js');
});

await test('the manifest ships every file the runtime needs', () => {
  const shipped = manifest.files ?? [];
  for (const required of ['lib', 'cordis.patch.yml']) {
    assert.ok(shipped.includes(required), `${required} must be in package.json files[]`);
  }
});

await test('the patch inserts exactly one row whose name is the package name', () => {
  const rows = [...patch.matchAll(/^\s*name:\s*'([^']+)'/gmu)].map((match) => match[1]);
  assert.equal(rows.length, 1, 'exactly one plugin row is expected');
  assert.equal(
    rows[0],
    manifest.name,
    'the inserted row must name this package, because the loader resolves it by module specifier',
  );
});

await test('the patch declares an id so a profile can target it for config', () => {
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/gmu)].map((match) => match[1]);
  assert.equal(ids.length, 1, 'exactly one row id is expected');
  assert.equal(ids[0], 'peak-valley-brake');
});

await test('the module exports the plugin shape the loader requires', () => {
  assert.equal(typeof module_.name, 'string');
  assert.ok(module_.name.length > 0, 'name must not be empty');
  assert.equal(typeof module_.apply, 'function', 'the loader calls apply(ctx, config)');
  assert.equal(typeof module_.Config, 'object');
});

await test('service dependencies are declared, because cordis refuses undeclared ones', () => {
  // Without this declaration, reading `ctx.commands` throws
  // `cannot get property "commands" without inject` and the entire profile fails
  // to boot — a real failure this assertion exists to keep from returning.
  assert.equal(typeof module_.inject, 'object', 'the module must export its inject declaration');
  assert.ok('commands' in module_.inject, 'commands must be declared to be readable at all');
});

await test('the command dependency is optional, so a headless composition still loads', () => {
  assert.equal(
    module_.inject.commands,
    null,
    'a nullish inject value marks the dependency optional; requiring it would break headless hosts',
  );
});

await test('Config implements the Standard Schema interface cordis validates through', () => {
  // cordis calls `Config['~standard'].validate(raw)` and throws an opaque
  // "Cannot read properties of undefined (reading 'validate')" without it, which
  // is exactly the failure mode this assertion exists to prevent.
  const standard = module_.Config['~standard'];
  assert.equal(typeof standard, 'object', 'Config must expose a ~standard property');
  assert.equal(typeof standard.validate, 'function', 'Config[~standard].validate must be callable');
  assert.equal(typeof standard.vendor, 'string');
});

await test('Config validation applies defaults for an empty configuration', () => {
  const parsed = module_.Config['~standard'].validate({});
  assert.equal(parsed.issues, undefined, 'an empty config must be valid');
  assert.deepEqual(parsed.value, {
    enabled: true,
    brakeLeadMinutes: 5,
    releaseDelayMinutes: 1,
    holdUserMessages: true,
    verifyWorkspaceOnResume: true,
    allowManualOverride: true,
    announceOnBrake: true,
    locale: 'auto',
    peakWindowsOverride: '',
    releaseTickSeconds: 30,
    home: '',
    debug: false,
  });
});

await test('Config validation accepts an absent config, which is what a bare row sends', () => {
  // A profile row with no `config:` key makes the loader validate `undefined`.
  // Rejecting it would make the plugin impossible to install without also
  // configuring it, so this exact input is asserted.
  const parsed = module_.Config['~standard'].validate(undefined);
  assert.equal(parsed.issues, undefined, 'an absent config must be valid');
  assert.equal(parsed.value.brakeLeadMinutes, 5);
  assert.equal(parsed.value.enabled, true);
});

await test('Config validation reports issues instead of throwing for a bad value', () => {
  const parsed = module_.Config['~standard'].validate({ brakeLeadMinutes: -5 });
  assert.ok(Array.isArray(parsed.issues) && parsed.issues.length > 0, 'a negative lead must be reported');
});

await test('every Config field carries a default, so no configuration is required', () => {
  const shape = module_.ConfigShape.shape;
  assert.ok(shape !== null && typeof shape === 'object', 'a zod object schema exposes its shape');
  const fields = Object.keys(shape);
  assert.ok(fields.length > 0);
  const parsed = module_.Config['~standard'].validate({});
  for (const field of fields) {
    assert.ok(field in parsed.value, `${field} must have a default, because an empty config must be valid`);
  }
});

await test('the exported Config fields are the ones normalizeConfig understands', () => {
  // Catches the class of bug where a field is declared for the loader but
  // silently ignored by the plugin, so an operator sets it and sees no effect.
  const declared = new Set(Object.keys(module_.ConfigShape.shape));
  const understood = new Set([
    'enabled',
    'brakeLeadMinutes',
    'releaseDelayMinutes',
    'holdUserMessages',
    'verifyWorkspaceOnResume',
    'allowManualOverride',
    'announceOnBrake',
    'locale',
    'peakWindowsOverride',
    'releaseTickSeconds',
    'home',
    'debug',
  ]);
  assert.deepEqual([...declared].sort(), [...understood].sort());
});

await test('the manifest exports point at modules that exist', async () => {
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (key === './package.json') continue;
    const resolved = join(root, target);
    const contents = await readFile(resolved, 'utf8');
    assert.ok(contents.length > 0, `${key} must resolve to a non-empty module`);
  }
});

await test('the client bundle is a loader registration and not the ESM source', async () => {
  const source = await readFile(join(root, manifest.exports['./client']), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/u, 'a client bundle must register itself');
  assert.match(source, /id:\s*"dsh-peak-valley-brake"/u);
  assert.ok(
    !/^\s*import\s/mu.test(source),
    'a served bundle must not contain import statements a browser cannot resolve',
  );
});

await test('the client bundle being served is the one the source builds', async () => {
  // The bundle is committed, so it can silently fall behind the source it was
  // built from — and a stale bundle is a bug that only appears in a browser.
  // Rebuilding and comparing is the only check that does not need one.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile: read } = await import('node:fs/promises');
  const before = await read(join(root, 'lib', 'client.bundle.js'), 'utf8');
  await promisify(execFile)(process.execPath, [join(root, 'scripts', 'build-client.mjs')], { cwd: root });
  const after = await read(join(root, 'lib', 'client.bundle.js'), 'utf8');
  assert.equal(after, before, 'lib/client.bundle.js is out of date; run `node scripts/build-client.mjs`');
});

await test('the settings schema is a real dependency and survives a hand-edited value', async () => {
  // Two failures in one place. The schema needs `schemastery` at load time, so a
  // manifest missing it is a boot failure rather than a warning. And schemastery
  // *throws* on an out-of-range value while the settings service resolves the whole
  // namespace when it registers — so a `min`/`max` on these fields would let a
  // hand-edited `settings.yaml` take the brake down with it, since the registration
  // runs in the same apply. The ranges are enforced where the values are used.
  assert.ok(manifest.dependencies?.schemastery, 'schemastery must be a runtime dependency');
  const { badgeSettingsSchema } = await import('../lib/badge-settings-schema.js');
  assert.equal(typeof badgeSettingsSchema, 'function');
  assert.equal(typeof badgeSettingsSchema.toJSON, 'function', 'the settings service serializes the schema');
  assert.doesNotThrow(() => badgeSettingsSchema({ badgeSize: 99999, hoverDelayMs: -1 }));
  assert.equal(badgeSettingsSchema({ badgeSize: 99999 }).badgeSize, 99999, 'passed through; the renderer clamps');
  assert.equal(badgeSettingsSchema({}).badgeVisible, true, 'a missing field must still resolve');
});

await test('the package name is a valid npm specifier the loader can resolve', () => {
  assert.match(manifest.name, /^[a-z0-9][a-z0-9._-]*$/u);
  assert.ok(!manifest.name.startsWith('.'), 'a relative name would not be installable');
});

await test('publishing to the public registry is refused, not merely discouraged', () => {
  // `private: true` alone did not stop `npm publish --dry-run` from exiting 0,
  // and this name is unclaimed on npm — so one command without `--dry-run` would
  // publish the package irreversibly. The prepublishOnly seal is what actually
  // refuses it. This assertion keeps the seal from being deleted later as
  // "unnecessary packaging friction".
  assert.equal(manifest.private, true, 'private: true is the first line of defence');
  assert.match(
    manifest.scripts?.prepublishOnly ?? '',
    /process\.exit\(1\)/u,
    'prepublishOnly must fail the publish, not merely warn',
  );
  assert.equal(
    manifest.publishConfig?.access,
    'restricted',
    'a restricted default keeps an accidental publish out of the public registry',
  );
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
