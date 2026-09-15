/**
 * Resolve which language this plugin's operator-facing text uses.
 *
 * The harness UI language is owned by `dsh-client-locale`, which persists the
 * choice to `$DSH_HOME/settings.yaml` for loopback pages and keeps it
 * process-local otherwise. A host plugin cannot reach that client service, so
 * this module reads the persisted preference when it exists and otherwise falls
 * back to the operating system's language — the best available proxy for a
 * mostly-Chinese user base on a variety of machines.
 *
 * Resolution never throws. A missing or unreadable settings file, an unknown
 * language tag, or a host that has never saved a preference all degrade to the
 * fallback instead of failing the plugin, because a language choice must never
 * be the reason a cost guard refuses to load.
 *
 * @module peak-valley-brake/locale
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SUPPORTED_LANGUAGES } from './messages.js';
import { harnessHome } from './hold-ledger.js';

/** Language used when nothing else can be determined. */
export const FALLBACK_LANGUAGE = 'en';

/** Settings keys, in priority order, that may carry a UI language preference. */
const SETTINGS_KEYS = Object.freeze(['ui-locale', 'locale', 'ui-language']);

/** Upper bound on the Windows registry lookup, so it can never stall a load. */
const WINDOWS_QUERY_TIMEOUT_MS = 5_000;

/** Default command runner for the Windows registry lookup. */
const defaultExec = promisify(execFile);

/**
 * Normalize a language tag to one this plugin ships strings for.
 *
 * Accepts the forms a system or settings file realistically produces —
 * `zh-CN`, `zh_CN`, `zh-Hans-CN`, `en-US.UTF-8` — and matches on the primary
 * subtag, which is the granularity the dictionaries actually distinguish.
 *
 * @param {unknown} tag - candidate language tag.
 * @returns {string|undefined} a supported language, or `undefined` when unmappable.
 */
export function normalizeLanguage(tag) {
  if (typeof tag !== 'string') return undefined;
  const primary = tag.trim().toLowerCase().split(/[-_.]/u)[0];
  if (primary === undefined || primary === '') return undefined;
  return SUPPORTED_LANGUAGES.includes(primary) ? primary : undefined;
}

/**
 * Derive a language from the operating system's environment.
 *
 * POSIX systems expose `LC_ALL`/`LC_MESSAGES`/`LANG`; Windows exposes
 * `LANGUAGE` and the `*_LANGUAGE`-style locale names.
 *
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @returns {string|undefined} a supported language, or `undefined`.
 */
export function languageFromEnvironment(env = process.env) {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const resolved = normalizeLanguage(env[name]);
    if (resolved !== undefined) return resolved;
  }
  // Windows reports names such as `zh-CN` or `Chinese (Simplified)_China`.
  // The `_` may follow a parenthesised qualifier, so both separators are cut.
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith('_LANGUAGE')) continue;
    const head = value.split(/[(_]/u)[0].trim();
    const resolved = normalizeLanguage(head === 'Chinese' ? 'zh' : head === 'English' ? 'en' : head);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * Derive a language from the runtime's own locale resolution.
 *
 * Neither POSIX nor Windows always exports a language environment variable —
 * a plain Windows install typically exports neither — so the ICU-backed
 * resolved locale is the next independent source. It is still only a guess at
 * the *harness UI* language, which is why it ranks below the persisted setting.
 *
 * @returns {string|undefined} a supported language, or `undefined`.
 */
export function languageFromRuntime() {
  try {
    return normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return undefined;
  }
}

/**
 * Read the Windows user default UI language, which is not exported as an
 * environment variable on a stock install.
 *
 * Reads `HKCU\Control Panel\International`'s `LocaleName` through `reg.exe`.
 * Any failure — a missing binary, a locked key, a non-Windows platform — is a
 * "cannot determine" answer rather than an error, because this is a hint about
 * presentation and nothing downstream depends on it being available.
 *
 * @param {object} [options] - lookup options.
 * @param {NodeJS.Platform} [options.platform] - platform override, for tests.
 * @param {Function} [options.run] - command runner override, for tests.
 * @returns {Promise<string|undefined>} a supported language, or `undefined`.
 */
export async function languageFromWindows(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return undefined;
  const exec = options.run ?? defaultExec;
  try {
    const { stdout } = await exec(
      'reg',
      ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'],
      { timeout: WINDOWS_QUERY_TIMEOUT_MS, windowsHide: true },
    );
    const match = /LocaleName\s+REG_SZ\s+(\S+)/u.exec(String(stdout));
    return match === null ? undefined : normalizeLanguage(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Read the harness's persisted UI language preference, when there is one.
 *
 * The settings file is small YAML. Only the language keys are needed, so this
 * deliberately reads the file as text rather than pulling in a YAML parser: a
 * parse failure here would be a load failure for a cosmetic preference.
 *
 * @param {object} [options] - read options.
 * @param {string} [options.home] - harness home override.
 * @returns {Promise<string|undefined>} a supported language, or `undefined`.
 */
export async function languageFromSettings(options = {}) {
  const file = join(options.home ?? harnessHome(), 'settings.yaml');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (!SETTINGS_KEYS.includes(key)) continue;
    const resolved = normalizeLanguage(value.replaceAll(/['"]/gu, ''));
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * Resolve the language to use.
 *
 * @param {object} [options] - resolution options.
 * @param {string} [options.configured] - an explicit `locale` configuration value.
 * @param {string} [options.home] - harness home override.
 * @param {NodeJS.ProcessEnv} [options.env] - environment override.
 * @param {NodeJS.Platform} [options.platform] - platform override, for tests.
 * @param {() => string|undefined} [options.runtime] - runtime-locale lookup override, for tests.
 * @param {Function} [options.run] - command runner override, for the Windows lookup.
 * @returns {Promise<{language: string, source: string}>} the language and where it came from.
 */
export async function resolveLanguage(options = {}) {
  const configured = normalizeLanguage(options.configured);
  if (configured !== undefined && options.configured !== 'auto') {
    return { language: configured, source: 'configured' };
  }
  const persisted = await languageFromSettings(options);
  if (persisted !== undefined) return { language: persisted, source: 'harness-settings' };
  const fromEnvironment = languageFromEnvironment(options.env ?? process.env);
  if (fromEnvironment !== undefined) return { language: fromEnvironment, source: 'system' };
  const fromRuntime = (options.runtime ?? languageFromRuntime)();
  if (fromRuntime !== undefined) return { language: fromRuntime, source: 'runtime-locale' };
  const fromWindows = await languageFromWindows(options);
  if (fromWindows !== undefined) return { language: fromWindows, source: 'system-locale' };
  return { language: FALLBACK_LANGUAGE, source: 'fallback' };
}
