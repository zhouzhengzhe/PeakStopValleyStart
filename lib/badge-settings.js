/**
 * The badge's user settings: one vocabulary shared by the host, the browser, and
 * the settings page.
 *
 * Deliberately free of any dependency the browser cannot carry. The schema that
 * the host hands to the settings service needs `schemastery`, so it lives in
 * `badge-settings-schema.js` and only the host imports it — this module is what
 * both halves agree on: the namespace, the field names, the ranges, and one
 * tolerant normaliser.
 *
 * Tolerant on purpose. Values reaching the browser have been through a settings
 * file a person can edit, a schema, and a JSON round trip; anything that does not
 * survive that must fall back to the default rather than reach a layout
 * calculation as `NaN`.
 *
 * @module peak-valley-brake/badge-settings
 */

/**
 * The settings namespace this plugin owns.
 *
 * Lowercase hyphenated, as the settings service requires, and equal to the
 * package name so the section is recognisable in `settings.yaml`.
 */
export const SETTINGS_NAMESPACE = 'peak-valley-brake';

/** Smallest and largest character heights a control may ask for. */
export const MIN_SIZE_PX = 64;
export const MAX_SIZE_PX = 320;
export const DEFAULT_SIZE_PX = 160;

/** Bounds on how long the toolbar survives the pointer leaving it. */
export const MIN_HOVER_MS = 0;
export const MAX_HOVER_MS = 3000;
export const DEFAULT_HOVER_MS = 600;

/** Bounds on how long a panel the operator opened stays open. Zero means it stays until closed. */
export const MIN_PANEL_MS = 0;
export const MAX_PANEL_MS = 60_000;
export const DEFAULT_PANEL_MS = 5000;

/** The field names, in the order a settings page should present them. */
export const BADGE_SETTING_FIELDS = Object.freeze([
  'badgeVisible',
  'badgeSize',
  'hoverDelayMs',
  'panelAutoHideMs',
]);

/** What every field resolves to when nobody has chosen anything. */
export const BADGE_SETTINGS_DEFAULTS = Object.freeze({
  badgeVisible: true,
  badgeSize: DEFAULT_SIZE_PX,
  hoverDelayMs: DEFAULT_HOVER_MS,
  panelAutoHideMs: DEFAULT_PANEL_MS,
});

/**
 * Bring a requested character height into the range the art supports.
 *
 * @param {unknown} value - the requested height in pixels.
 * @returns {number|undefined} a usable size, or undefined when there is none.
 */
export function clampSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return undefined;
  return Math.round(Math.min(Math.max(size, MIN_SIZE_PX), MAX_SIZE_PX));
}

/**
 * Bring a requested toolbar grace period into range.
 *
 * @param {unknown} value - the requested period in milliseconds.
 * @returns {number|undefined} a usable period, or undefined when there is none.
 */
export function clampHover(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return undefined;
  return Math.round(Math.min(Math.max(ms, MIN_HOVER_MS), MAX_HOVER_MS));
}

/**
 * Bring a requested panel lifetime into range.
 *
 * @param {unknown} value - the requested period in milliseconds.
 * @returns {number|undefined} a usable period, or undefined when there is none.
 */
export function clampPanelMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return undefined;
  return Math.round(Math.min(Math.max(ms, MIN_PANEL_MS), MAX_PANEL_MS));
}

/**
 * Reduce anything that claims to be badge settings to a complete, valid object.
 *
 * Returns every field, always: a caller applying these should never have to
 * distinguish "absent" from "false" from "invalid".
 *
 * @param {unknown} raw - the candidate settings.
 * @returns {{badgeVisible: boolean, badgeSize: number, hoverDelayMs: number, panelAutoHideMs: number}} the resolved settings.
 */
export function normalizeBadgeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    // Only an explicit `false` hides the character: a missing field must show it,
    // because a badge nobody can see is indistinguishable from a broken plugin.
    badgeVisible: source.badgeVisible !== false,
    badgeSize: clampSize(source.badgeSize) ?? DEFAULT_SIZE_PX,
    hoverDelayMs: clampHover(source.hoverDelayMs) ?? DEFAULT_HOVER_MS,
    panelAutoHideMs: clampPanelMs(source.panelAutoHideMs) ?? DEFAULT_PANEL_MS,
  };
}

/**
 * Which fields differ from the defaults.
 *
 * The host's own settings tab marks a field "overridden" when it appears in the
 * user layer rather than when its value differs, so this is for the plugin's page
 * to offer a reset — not a substitute for that.
 *
 * @param {unknown} raw - the candidate settings.
 * @returns {string[]} the field names that were set explicitly.
 */
export function overriddenFields(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  return BADGE_SETTING_FIELDS.filter((field) => Object.hasOwn(source, field));
}
