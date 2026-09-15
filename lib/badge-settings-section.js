/**
 * The badge's page in the harness Settings dialog.
 *
 * Registered as an occupant of the `settings.section` slot, which is declared at
 * runtime by the settings shell rather than by a package, so it must be reached
 * through `slots.inject` — a bare `register` at `apply` time would find no such
 * slot. The occupant has to be a React component: the renderer always invokes slot
 * occupants as components, so a plain DOM renderer cannot sit here.
 *
 * React is taken from the host's own module table (`require('react')`, satisfied
 * by the platform seed) rather than bundled. Bundling a second copy would give the
 * page two React instances, and hooks would throw — which is why the build marks
 * React external.
 *
 * The page is deliberately plain: three fields, each with a reset, and no form
 * library. A harness-rendered form for third-party sections does not exist, so
 * these controls are hand-rolled, and every one of them is optional — if the
 * settings plane is missing the whole page says so instead of half-working.
 *
 * @module peak-valley-brake/badge-settings-section
 */

import React from 'react';

import {
  BADGE_SETTING_FIELDS,
  MAX_HOVER_MS,
  MAX_SIZE_PX,
  MIN_HOVER_MS,
  MIN_SIZE_PX,
} from './badge-settings.js';

/** The nav cell's id. A fresh id adds a section; reusing a shipped one would replace it. */
export const SECTION_ID = 'peak-valley-brake';

/** Where the nav cell sits among the shipped sections. */
export const SECTION_ORDER = 120;

/** The nav cell's text. */
export const SECTION_LABEL = '峰谷刹车';

/** Text the page shows. Chinese, matching the rest of this plugin's messages. */
export const SECTION_LABELS = Object.freeze({
  loading: '正在读取设置…',
  unavailable: '本部署没有设置服务，角色使用内置默认值。',
  intro: '这些只影响角色的显示。拦截与放行始终按峰谷时段工作，与本页设置无关。',
  badgeVisible: '显示角色',
  badgeVisibleHint: '关闭后仍会照常拦截与放行工作；随时可以从本页重新开启。',
  badgeSize: '大小（像素）',
  badgeSizeHint: `范围 ${MIN_SIZE_PX}–${MAX_SIZE_PX}，超出范围按边界显示。`,
  hoverDelayMs: '悬停停留（毫秒）',
  hoverDelayHint: `鼠标移开后工具栏停留多久，便于移动到按钮上。范围 ${MIN_HOVER_MS}–${MAX_HOVER_MS}。`,
  overridden: '已覆盖',
  reset: '恢复默认',
  resetAll: '全部恢复默认',
  section: '角色徽章',
});

/**
 * Build the settings page for one settings scope.
 *
 * @param {object} options - the page's collaborators.
 * @param {object|undefined} options.scope - the namespace's settings scope.
 * @param {object} [options.labels] - text overrides.
 * @returns {Function} a React component the slot can render.
 */
export function createSettingsSection(options) {
  const labels = { ...SECTION_LABELS, ...(options.labels ?? {}) };
  const scope = options.scope;

  return function BadgeSettingsSection() {
    const readSnapshot = () =>
      typeof scope?.getSnapshot === 'function' ? scope.getSnapshot() : { status: 'unavailable' };
    const [snapshot, setSnapshot] = React.useState(readSnapshot);

    React.useEffect(() => {
      if (typeof scope?.subscribe !== 'function') return undefined;
      // Subscribing rather than trusting the first read: another window, or the
      // settings file itself, can change these while the page is open.
      const unsubscribe = scope.subscribe(() => setSnapshot(readSnapshot()));
      return typeof unsubscribe === 'function' ? unsubscribe : undefined;
    }, []);

    if (snapshot === null || typeof snapshot !== 'object') {
      return React.createElement('div', null, labels.loading);
    }
    if (snapshot.status !== 'ready') {
      return React.createElement(
        'div',
        { style: { padding: '8px 0', opacity: 0.7 } },
        snapshot.status === 'unavailable' ? labels.unavailable : labels.loading,
      );
    }

    const value = snapshot.value ?? {};
    const user = snapshot.user ?? {};
    const isOverridden = (field) => Object.hasOwn(user, field);
    const write = (field, next) => {
      // Fire and forget: these return a promise, and a render path must not await.
      void scope.set(field, next);
    };
    const reset = (field) => {
      void scope.unset(field);
    };

    const row = (field, label, hint, control) =>
      React.createElement(
        'div',
        { key: field, style: { padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))' } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('span', { style: { minWidth: '8em' } }, label),
          control,
          isOverridden(field)
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: () => reset(field),
                  style: {
                    marginLeft: 'auto',
                    border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary, #868e96)',
                    borderRadius: '6px',
                    padding: '2px 8px',
                    cursor: 'pointer',
                  },
                },
                labels.reset,
              )
            : null,
        ),
        React.createElement(
          'div',
          { style: { marginTop: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #868e96)' } },
          hint,
        ),
      );

    const checkbox = (field) =>
      React.createElement('input', {
        type: 'checkbox',
        checked: value[field] !== false,
        onChange: (event) => write(field, event.target.checked),
      });

    const number = (field, min, max, step) =>
      React.createElement('input', {
        type: 'number',
        min,
        max,
        step,
        value: Number.isFinite(Number(value[field])) ? Number(value[field]) : '',
        onChange: (event) => {
          const next = Number(event.target.value);
          // Ignore an empty or half-typed box rather than writing NaN into the
          // settings file; the field keeps its previous value until it parses.
          if (Number.isFinite(next)) write(field, next);
        },
        style: {
          width: '6em',
          padding: '2px 6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
          borderRadius: '6px',
          background: 'transparent',
          color: 'inherit',
        },
      });

    const anyOverridden = BADGE_SETTING_FIELDS.some((field) => isOverridden(field));

    return React.createElement(
      'div',
      { style: { padding: '4px 0' } },
      React.createElement('div', { style: { fontSize: '12px', opacity: 0.7, marginBottom: '8px' } }, labels.intro),
      row('badgeVisible', labels.badgeVisible, labels.badgeVisibleHint, checkbox('badgeVisible')),
      row('badgeSize', labels.badgeSize, labels.badgeSizeHint, number('badgeSize', MIN_SIZE_PX, MAX_SIZE_PX, 1)),
      row('hoverDelayMs', labels.hoverDelayMs, labels.hoverDelayHint, number('hoverDelayMs', MIN_HOVER_MS, MAX_HOVER_MS, 50)),
      anyOverridden
        ? React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                for (const field of BADGE_SETTING_FIELDS) if (isOverridden(field)) reset(field);
              },
              style: {
                marginTop: '12px',
                border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
                background: 'transparent',
                color: 'inherit',
                borderRadius: '6px',
                padding: '4px 10px',
                cursor: 'pointer',
              },
            },
            labels.resetAll,
          )
        : null,
    );
  };
}

/**
 * Put the page in the Settings dialog's nav.
 *
 * Every step is guarded. This runs in the operator's page next to the badge, and a
 * missing or differently-shaped slot registry must cost the settings page only —
 * never the badge, and never an exception in someone's UI.
 *
 * @param {object} ctx - the client plugin context.
 * @param {object} [options] - the page's collaborators.
 * @param {object|undefined} [options.scope] - the namespace's settings scope.
 * @param {object} [options.labels] - text overrides.
 * @returns {(() => void)|undefined} an unregister function, when one was registered.
 */
export function registerSettingsSection(ctx, options = {}) {
  let slots;
  try {
    slots = ctx.slots;
  } catch {
    return undefined;
  }
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    return undefined;
  }

  const component = createSettingsSection(options);
  try {
    // `inject`, not `register`: `settings.section` is declared by the settings shell
    // while it is mounted, so at this moment the slot may not exist yet.
    return slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: SECTION_LABEL,
        },
        component,
      ),
    );
  } catch {
    return undefined;
  }
}
