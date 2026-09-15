/**
 * The settings schema the host hands to the harness settings service.
 *
 * Separate from `badge-settings.js` for one reason: it imports `schemastery`, and
 * that must never reach the browser bundle. The host service resolves a namespace
 * by *calling* the schema and serialises it with `toJSON()`, so the schema format
 * is not a free choice — it is whatever `dsh-settings` accepts.
 *
 * @module peak-valley-brake/badge-settings-schema
 */

import Schema from 'schemastery';

import {
  DEFAULT_HOVER_MS,
  DEFAULT_PANEL_MS,
  DEFAULT_SIZE_PX,
  MAX_HOVER_MS,
  MAX_PANEL_MS,
  MAX_SIZE_PX,
  MIN_HOVER_MS,
  MIN_PANEL_MS,
  MIN_SIZE_PX,
} from './badge-settings.js';

/**
 * The namespace's schema: four preferences, each with the default the badge uses
 * when the field is absent.
 *
 * **No `min`/`max`, deliberately.** schemastery *rejects* an out-of-range value
 * rather than clamping it, and `register` resolves the whole namespace up front —
 * so a hand-edited `settings.yaml` carrying `badgeSize: 9999` would make the
 * registration itself throw. This plugin's registration runs in the same `apply`
 * as the brake, so a cosmetic preference would be able to stop the brake guarding.
 * That trade is the wrong way round: the ranges are documented here for whoever
 * reads the schema, and enforced by the `clamp*` helpers at every point the values
 * are actually used, where a wrong number can only produce a wrong size.
 *
 * The type is still `number`, so a string where a number belongs is rejected —
 * that is a malformed document rather than a preference, and the caller degrades
 * to the defaults instead of the plugin failing.
 */
export const badgeSettingsSchema = Schema.object({
  badgeVisible: Schema.boolean()
    .default(true)
    .description('在页面角落显示角色。关闭后仍会照常拦截与放行工作。'),
  badgeSize: Schema.number()
    .default(DEFAULT_SIZE_PX)
    .description(`角色高度（像素），范围 ${MIN_SIZE_PX}–${MAX_SIZE_PX}，超出范围时按边界渲染。`),
  hoverDelayMs: Schema.number()
    .default(DEFAULT_HOVER_MS)
    .description(`鼠标移开后工具栏停留多久（毫秒），范围 ${MIN_HOVER_MS}–${MAX_HOVER_MS}，便于移动到按钮上。`),
  panelAutoHideMs: Schema.number()
    .default(DEFAULT_PANEL_MS)
    .description(
      `手动展开的状态面板多久后自动收起（毫秒），范围 ${MIN_PANEL_MS}–${MAX_PANEL_MS}；设为 0 则一直显示到手动关闭。`,
    ),
}).description('峰谷刹车：角色徽章');

/**
 * The layer the user's own choices resolve above.
 *
 * Kept as a value rather than schema defaults alone so the settings file, the
 * schema and the badge all agree on one set of numbers.
 */
export const badgeSettingsBase = Object.freeze({
  badgeVisible: true,
  badgeSize: DEFAULT_SIZE_PX,
  hoverDelayMs: DEFAULT_HOVER_MS,
  panelAutoHideMs: DEFAULT_PANEL_MS,
});
