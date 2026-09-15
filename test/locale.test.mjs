/**
 * Self-check for the message dictionaries and language resolution.
 *
 * Run with `node test/locale.test.mjs`.
 *
 * The highest-value assertion here is dictionary parity: a key present in one
 * language and missing from the other fails silently at runtime — the operator
 * simply sees English (or a crash) in the middle of a Chinese sentence. Parity
 * is checked structurally, at every nesting level, so a translation cannot
 * quietly fall behind.
 *
 * @module peak-valley-brake/test/locale
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FALLBACK_LANGUAGE,
  languageFromEnvironment,
  languageFromSettings,
  languageFromWindows,
  normalizeLanguage,
  resolveLanguage,
} from '../lib/locale.js';
import { DICTIONARIES, OVERRIDE_LABELS, STATE_LABELS, SUPPORTED_LANGUAGES, dictionaryFor, render } from '../lib/messages.js';

const results = { passed: 0, failed: 0 };

/**
 * Run one named async case and record its outcome.
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
 * Collect every leaf path in a nested dictionary.
 * @param {object} node - current node.
 * @param {string} [prefix] - path accumulated so far.
 * @returns {string[]} sorted leaf paths.
 */
function leafPaths(node, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object') paths.push(...leafPaths(value, path));
    else paths.push(path);
  }
  return paths.sort();
}

process.stdout.write('peak-valley-brake locale and messages\n\n');

process.stdout.write('dictionary parity\n');

await test('both languages define exactly the same text keys', () => {
  const languages = Object.keys(DICTIONARIES);
  assert.ok(languages.length >= 2, 'at least two languages are expected');
  const reference = leafPaths(DICTIONARIES.en);
  for (const language of languages) {
    assert.deepEqual(
      leafPaths(DICTIONARIES[language]),
      reference,
      `${language} and en must cover the same keys, or a string silently falls back mid-sentence`,
    );
  }
});

await test('every entry is a non-empty string or a function', () => {
  for (const [language, table] of Object.entries(DICTIONARIES)) {
    const check = (node, prefix) => {
      for (const [key, value] of Object.entries(node)) {
        const path = `${language}.${prefix}${key}`;
        if (value !== null && typeof value === 'object') check(value, `${path}.`);
        else if (typeof value === 'string') assert.ok(value.length > 0, `${path} must not be empty`);
        else assert.equal(typeof value, 'function', `${path} must be a string or a function`);
      }
    };
    check(table, '');
  }
});

await test('no Chinese entry is left holding English placeholder prose', () => {
  // A common translation failure is pasting the English through unchanged. A
  // handful of entries legitimately have no letters (the list prefix), so the
  // check is limited to entries that look like sentences.
  const suspicious = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}${key}`;
      if (value !== null && typeof value === 'object') {
        walk(value, `${path}.`);
        continue;
      }
      const sample = typeof value === 'function' ? value({ count: 1, releaseUtc: 'X', releaseLocal: 'Y', state: 'S', reasons: 'R', before: 'A', after: 'B', kind: 'K', untilUtc: 'U', sessionId: 'I', message: 'M', subcommand: 'C', value: 'V', summary: 'W', note: 'N', edge: 'E', atUtc: 'T', lead: 1, delay: 1 }) : value;
      if (typeof sample !== 'string' || sample.length < 12) continue;
      if (/^[\x00-\x7F\s]*$/u.test(sample)) suspicious.push(`${path} = ${sample}`);
    }
  };
  walk(DICTIONARIES.zh, 'zh.');
  assert.deepEqual(suspicious, [], 'these Chinese entries contain only ASCII, which usually means untranslated');
});

await test('the state and override labels are complete in both languages', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    assert.deepEqual(
      Object.keys(STATE_LABELS[language]).sort(),
      ['armed', 'open', 'peak', 'releasing'],
      `${language} must label every schedule state`,
    );
    assert.deepEqual(Object.keys(OVERRIDE_LABELS[language]).sort(), ['once', 'window']);
  }
});

process.stdout.write('\nrendering\n');

await test('a function entry receives the values it interpolates', () => {
  const text = render(dictionaryFor('en'), 'receipt.summary', { count: 3, releaseUtc: '2026-01-01 00:00' });
  assert.match(text, /3 message/u);
  assert.match(text, /2026-01-01 00:00/u);
});

await test('a Chinese receipt reports the same facts in Chinese', () => {
  const text = render(dictionaryFor('zh'), 'receipt.summary', { count: 3, releaseUtc: '2026-01-01 00:00' });
  assert.match(text, /3 条消息/u);
  assert.match(text, /2026-01-01 00:00/u, 'times stay in a machine-checkable form');
  assert.match(text, /峰时/u);
});

await test('a string entry has its placeholders filled', () => {
  const text = render(dictionaryFor('en'), 'reconstruction', { summary: 'the original prompt' });
  assert.match(text, /the original prompt/u);
  assert.ok(!text.includes('{summary}'), 'an unfilled placeholder must not survive');
});

await test('an unknown language falls back to English rather than throwing', () => {
  const table = dictionaryFor('fr');
  assert.equal(table.language, 'en');
  assert.match(render(table, 'receipt.summary', { count: 1, releaseUtc: 'x' }), /message/u);
});

await test('asking for a missing key throws instead of returning undefined', () => {
  assert.throws(() => render(dictionaryFor('en'), 'receipt.nonexistent'), TypeError);
});

process.stdout.write('\nlanguage tag normalization\n');

await test('real-world tags normalize to a supported language', () => {
  const cases = {
    'zh-CN': 'zh',
    zh_CN: 'zh',
    'zh-Hans-CN': 'zh',
    'en-US.UTF-8': 'en',
    'ZH': 'zh',
    en: 'en',
  };
  for (const [tag, expected] of Object.entries(cases)) {
    assert.equal(normalizeLanguage(tag), expected, `${tag} should normalize to ${expected}`);
  }
});

await test('unsupported and malformed tags normalize to undefined', () => {
  for (const tag of ['fr-FR', 'de', '', '   ', undefined, null, 42, {}]) {
    assert.equal(normalizeLanguage(tag), undefined, `${JSON.stringify(tag)} must not resolve`);
  }
});

process.stdout.write('\nlanguage sources\n');

await test('POSIX environment variables are read in priority order', () => {
  assert.equal(languageFromEnvironment({ LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(languageFromEnvironment({ LANG: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8' }), 'en', 'LC_ALL wins');
  assert.equal(languageFromEnvironment({ LANG: 'fr_FR' }), undefined, 'an unsupported system language is not a match');
});

await test('Windows user default UI language names are understood', () => {
  assert.equal(languageFromEnvironment({ HARDWARE_LANGUAGE: 'Chinese (Simplified)_China' }), 'zh');
  assert.equal(languageFromEnvironment({ HARDWARE_LANGUAGE: 'Chinese_China' }), 'zh');
  assert.equal(languageFromEnvironment({ HARDWARE_LANGUAGE: 'English_United States' }), 'en');
});

await test('the persisted harness setting is found in settings.yaml', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pvb-locale-'));
  try {
    await writeFile(join(home, 'settings.yaml'), "ui-theme:\n  fontSize: 16\nui-locale: 'zh-CN'\n", 'utf8');
    assert.equal(await languageFromSettings({ home }), 'zh');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test('a settings file without a language key yields nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pvb-locale-'));
  try {
    await writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  fontSize: 16\n', 'utf8');
    assert.equal(await languageFromSettings({ home }), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test('a missing or unreadable settings file is not an error', async () => {
  assert.equal(await languageFromSettings({ home: join(tmpdir(), 'pvb-absent-9f3a') }), undefined);
});

await test('the Windows registry lookup is a no-op off Windows', async () => {
  let invoked = false;
  const result = await languageFromWindows({
    platform: 'linux',
    run: () => {
      invoked = true;
      return Promise.resolve({ stdout: '' });
    },
  });
  assert.equal(result, undefined);
  assert.equal(invoked, false, 'no command may run on a platform that has no such key');
});

await test('the Windows registry lookup reads LocaleName when reg succeeds', async () => {
  const result = await languageFromWindows({
    platform: 'win32',
    run: () => Promise.resolve({ stdout: '    LocaleName    REG_SZ    zh-CN\r\n' }),
  });
  assert.equal(result, 'zh');
});

await test('a failing registry lookup is reported as "cannot determine", not thrown', async () => {
  const result = await languageFromWindows({
    platform: 'win32',
    run: () => Promise.reject(new Error('reg is not available')),
  });
  assert.equal(result, undefined);
});

process.stdout.write('\nresolution order\n');

await test('an explicit configuration wins over everything else', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pvb-locale-'));
  try {
    await writeFile(join(home, 'settings.yaml'), "ui-locale: 'zh'\n", 'utf8');
    const resolved = await resolveLanguage({ configured: 'en', home, env: { LANG: 'zh_CN' } });
    assert.equal(resolved.language, 'en');
    assert.equal(resolved.source, 'configured');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test('auto prefers the persisted harness setting over the system', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pvb-locale-'));
  try {
    await writeFile(join(home, 'settings.yaml'), "ui-locale: 'en'\n", 'utf8');
    const resolved = await resolveLanguage({ configured: 'auto', home, env: { LANG: 'zh_CN.UTF-8' } });
    assert.equal(resolved.language, 'en');
    assert.equal(resolved.source, 'harness-settings');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test('auto falls back to the system language when no setting exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pvb-locale-'));
  try {
    const resolved = await resolveLanguage({
      configured: 'auto',
      home,
      env: { LANG: 'zh_CN.UTF-8' },
      platform: 'linux',
      runtime: () => undefined,
    });
    assert.equal(resolved.language, 'zh');
    assert.equal(resolved.source, 'system');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

await test('resolution always yields a supported language, whatever the machine says', async () => {
  const resolved = await resolveLanguage({
    configured: 'auto',
    home: join(tmpdir(), 'pvb-absent-9f3a'),
    env: {},
    platform: 'linux',
    runtime: () => undefined,
  });
  assert.ok(SUPPORTED_LANGUAGES.includes(resolved.language));
  assert.equal(resolved.language, FALLBACK_LANGUAGE, 'with nothing to go on, English is the documented fallback');
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
