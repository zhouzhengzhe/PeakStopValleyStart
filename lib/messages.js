/**
 * Operator-facing message texts, in the harness's two supported languages.
 *
 * Why a dictionary and not inline strings: every message this plugin shows is
 * read by a human at a moment when something was deliberately withheld, and the
 * plugin ships to a mostly-Chinese user base on an OS whose language is a poor
 * guide to the harness UI language. Hard-coding either language would be wrong
 * for half the installs, so the language is resolved once (see `locale.js`) and
 * every string is looked up.
 *
 * Every entry is a function of the facts it reports, so a translation cannot
 * silently drop a number the operator needs. `zh` mirrors `en` key for key; the
 * check in `test/locale.test.mjs` fails if the two drift apart.
 *
 * @module peak-valley-brake/messages
 */

/**
 * Render one dictionary entry.
 *
 * Entries are functions of the facts they report, so a translation cannot drop
 * a number the operator needs. This resolves the entry and applies it, which is
 * the only way callers should read text out of the dictionaries.
 *
 * @param {object} dictionary - a table returned by {@link dictionaryFor}.
 * @param {string} path - dotted path to the entry, e.g. `receipt.body`.
 * @param {Record<string, string|number>} [values] - values the entry interpolates.
 * @returns {string} the rendered text.
 */
export function render(dictionary, path, values = {}) {
  let entry = dictionary.strings;
  for (const segment of path.split('.')) {
    entry = entry?.[segment];
  }
  if (typeof entry === 'function') return String(entry(values));
  if (typeof entry === 'string') return fill(entry, values);
  throw new TypeError(`peak-valley-brake: no text at "${path}" in the ${dictionary.language} dictionary`);
}

/**
 * Placeholder substitution for `{name}` templates.
 *
 * Used for the few entries that are plain strings rather than functions.
 *
 * @param {string} template - text containing `{token}` placeholders.
 * @param {Record<string, string|number>} values - token values.
 * @returns {string} the rendered text.
 */
function fill(template, values) {
  return String(template).replaceAll(/\{(\w+)\}/gu, (match, token) =>
    Object.hasOwn(values, token) ? String(values[token]) : match,
  );
}

/** English texts. */
const en = {
  receipt: {
    summary: (v) => `Peak pricing: ${v.count} message(s) withheld, released at ${v.releaseUtc} UTC`,
    body: (v) =>
      [
        `[peak-valley-brake] ${v.count} message(s) are withheld because the API is priced at peak right now.`,
        `They are queued, not lost, and will be delivered automatically at ${v.releaseUtc} UTC (${v.releaseLocal} UTC+8).`,
        'To release them immediately, run one of:',
        '  /peak-valley now    - release these once; the next message is withheld again',
        '  /peak-valley window - keep dispatching until the next schedule change, so a normal',
        '                        back-and-forth works; it re-arms itself at that boundary, and',
        '                        /peak-valley cancel ends it early',
      ].join('\n'),
  },
  drift: {
    intro:
      '[peak-valley-brake] The workspace changed while this request was withheld during peak pricing. Do not rely on file contents you read earlier; re-read the affected files before editing them.',
    reasonPrefix: '- ',
    pathsHeading: 'Changed paths:',
    pathsMissing: 'The changed paths could not be listed; treat any earlier file reading as possibly stale.',
    unverified: (v) =>
      `[peak-valley-brake] This workspace could not be checked for external changes while work was withheld (${v.reasons}). Before acting on files you read earlier, re-read the ones you are about to change.`,
    reasonCommit: (v) => `the checked-out commit changed from ${v.before} to ${v.after}`,
    reasonStatus: 'the set of modified and untracked files changed',
    noFingerprint: 'no fingerprint was recorded at hold time',
    noWorkingDirectory: 'the session has no working directory',
    notARepository: 'the workspace is not a git repository, or git is unavailable',
    unmeasurable: 'the workspace could not be measured',
  },
  reconstruction:
    '[peak-valley-brake] A prompt withheld during peak pricing could not be restored verbatim after a host restart. Its recorded summary was: {summary}',
  command: {
    statusSchedule: (v) => `schedule: ${v.state} (${v.phase})`,
    statusDispatchHeld: (v) => `dispatch: held — ${v.reason}`,
    statusDispatchOpen: (v) => `dispatch: open — ${v.reason}`,
    statusNextNone: 'next change: none scheduled',
    statusNext: (v) => `next change: ${v.edge} at ${v.atUtc}`,
    statusRelease: (v) => `release at: ${v.atUtc}`,
    statusHeldCount: (v) => `held messages here: ${v.count}`,
    statusOverrideNone: 'none',
    statusOverride: (v) => `${v.kind}, until ${v.untilUtc}`,
    statusOverrideDisabled: 'disabled by configuration',
    statusOverrideLine: (v) => `manual override: ${v.value}`,
    statusLastDeliveryFailed: (v) =>
      `last re-delivery FAILED at ${v.atUtc} UTC via ${v.stage}: ${v.error}`,
    overrideDisabled: 'manual override is disabled by configuration (allowManualOverride: false)',
    grantedOnce: (v) =>
      `the withheld work in this session is being released now; dispatch re-arms at ${v.untilUtc} UTC`,
    grantedWindow: (v) =>
      `every session may dispatch again until the next schedule change; dispatch re-arms at ${v.untilUtc} UTC`,
    cancelled: 'manual override cancelled; the schedule governs dispatch again',
    cancelNoop: 'no manual override was active',
    unknownSubcommand: (v) => `unknown subcommand "${v.subcommand}"; expected status, now, window, or cancel`,
  },
  log: {
    noCommandSurface: 'no command surface in this composition; use the config switch to change cost policy',
    commandRegistrationFailed: (v) => `could not register the /peak-valley command: ${v.message}`,
    receiptFailed: (v) => `could not post the hold receipt: ${v.message}`,
    holding: (v) => `holding ${v.count} message(s) until ${v.untilUtc} (${v.reason})`,
    overrideGranted: (v) => `manual override granted (${v.kind}) by ${v.sessionId}; dispatching until ${v.untilUtc}`,
    overrideSpent: 'one-shot manual override spent',
    overrideCancelled: 'manual override cancelled; the schedule governs dispatch again',
    listenerInstallFailed: (v) => `could not install listeners on ${v.sessionId}: ${v.message}`,
    driftDetected: (v) => `workspace drift detected before re-delivery: ${v.reasons}`,
    driftUnverified: (v) => `workspace could not be verified before re-delivery: ${v.reasons}`,
    started: (v) =>
      `armed; currently ${v.state} (brake lead ${v.lead}m, release delay ${v.delay}m)`,
  },
};

/** Chinese texts, mirroring {@link en} key for key. */
const zh = {
  receipt: {
    summary: (v) => `峰时计价：已拦截 ${v.count} 条消息，将于 ${v.releaseUtc} UTC 放行`,
    body: (v) =>
      [
        `[peak-valley-brake] 当前 API 处于峰时计价，已拦截 ${v.count} 条消息。`,
        `它们只是排队、并未丢失，将于 ${v.releaseLocal}（UTC+8，即 ${v.releaseUtc} UTC）自动放行。`,
        '如需立即放行，二选一：',
        '  /peak-valley now    —— 只放行这一次；你发的下一条消息仍会被拦截',
        '  /peak-valley window —— 放行到下一个调度切换为止，便于连续干活',
        '                        （到点自动重新武装；/peak-valley cancel 可提前结束）',
      ].join('\n'),
  },
  drift: {
    intro:
      '[peak-valley-brake] 这条请求被峰时拦截期间，工作区发生了变更。请勿依赖你先前读取到的文件内容；在修改之前先重新读取受影响的文件。',
    reasonPrefix: '- ',
    pathsHeading: '发生变更的路径：',
    pathsMissing: '无法列出变更路径；请把你先前的任何文件读取都视为可能已过期。',
    unverified: (v) =>
      `[peak-valley-brake] 工作被拦截期间无法校验该工作区是否被外部改动（${v.reasons}）。在依据先前读取的文件行动之前，先重新读取你准备修改的那些文件。`,
    reasonCommit: (v) => `检出的提交从 ${v.before} 变为 ${v.after}`,
    reasonStatus: '已修改与未跟踪文件的集合发生了变化',
    noFingerprint: '停机时未能记录工作区指纹',
    noWorkingDirectory: '该会话没有工作目录',
    notARepository: '该工作区不是 git 仓库，或 git 不可用',
    unmeasurable: '无法测量该工作区',
  },
  reconstruction:
    '[peak-valley-brake] 一条在峰时被拦截的提示词在宿主重启后无法逐字还原。其记录到的摘要为：{summary}',
  command: {
    statusSchedule: (v) => `档位：${v.state}（${v.phase}）`,
    statusDispatchHeld: (v) => `调度：已拦截 —— ${v.reason}`,
    statusDispatchOpen: (v) => `调度：放行 —— ${v.reason}`,
    statusNextNone: '下次切换：无',
    statusNext: (v) => `下次切换：${v.edge}，${v.atUtc}`,
    statusRelease: (v) => `放行时刻：${v.atUtc}`,
    statusHeldCount: (v) => `本会话滞留消息数：${v.count}`,
    statusOverrideNone: '无',
    statusOverride: (v) => `${v.kind}，至 ${v.untilUtc}`,
    statusOverrideDisabled: '已被配置禁用',
    statusOverrideLine: (v) => `手动覆盖：${v.value}`,
    statusLastDeliveryFailed: (v) =>
      `最近一次重投递**失败**于 ${v.atUtc} UTC，经由 ${v.stage}：${v.error}`,
    overrideDisabled: '手动覆盖已被配置禁用（allowManualOverride: false）',
    grantedOnce: (v) => `正在放行本会话被拦截的工作；调度将于 ${v.untilUtc} UTC 重新武装`,
    grantedWindow: (v) => `所有会话可再次调度，直至下一个档位切换；调度将于 ${v.untilUtc} UTC 重新武装`,
    cancelled: '已撤销手动覆盖；调度重新接管',
    cancelNoop: '当前没有生效的手动覆盖',
    unknownSubcommand: (v) => `未知子命令 "${v.subcommand}"；应为 status、now、window 或 cancel`,
  },
  log: {
    noCommandSurface: '当前组合没有命令面；如需调整成本策略请改用配置项',
    commandRegistrationFailed: (v) => `无法注册 /peak-valley 命令：${v.message}`,
    receiptFailed: (v) => `无法投递停机回执：${v.message}`,
    holding: (v) => `已拦截 ${v.count} 条消息，至 ${v.untilUtc}（${v.reason}）`,
    overrideGranted: (v) => `已由 ${v.sessionId} 授予手动覆盖（${v.kind}）；放行至 ${v.untilUtc}`,
    overrideSpent: '一次性手动覆盖已用尽',
    overrideCancelled: '已撤销手动覆盖；调度重新接管',
    listenerInstallFailed: (v) => `无法在 ${v.sessionId} 上安装监听器：${v.message}`,
    driftDetected: (v) => `重投递前检出工作区漂移：${v.reasons}`,
    driftUnverified: (v) => `重投递前无法校验工作区：${v.reasons}`,
    started: (v) => `已武装；当前 ${v.state}（提前刹车 ${v.lead} 分钟，延后放行 ${v.delay} 分钟）`,
  },
};

/** The dictionary table, keyed by language tag. */
export const DICTIONARIES = Object.freeze({ en, zh });

/** Languages this plugin ships strings for. */
export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(DICTIONARIES));

/**
 * Resolve a text table for one language.
 *
 * @param {string} language - a supported language tag; an unknown tag falls back to English.
 * @returns {{language: string, strings: object}} the resolved language and its table.
 */
export function dictionaryFor(language) {
  const resolved = Object.hasOwn(DICTIONARIES, language) ? language : 'en';
  return { language: resolved, strings: DICTIONARIES[resolved] };
}

/**
 * The schedule-state names as operators see them.
 *
 * Kept here rather than in `time-window.js` so the schedule module stays free of
 * presentation concerns, and kept exhaustive so a new state cannot be added
 * without a translation.
 */
export const STATE_LABELS = Object.freeze({
  en: Object.freeze({ peak: 'peak', armed: 'pre-peak brace', releasing: 'post-peak brace', open: 'open' }),
  zh: Object.freeze({ peak: '峰时', armed: '峰前刹车', releasing: '峰后延放', open: '谷时' }),
});

/**
 * The override-kind names as operators see them.
 */
export const OVERRIDE_LABELS = Object.freeze({
  en: Object.freeze({ once: 'one turn', window: 'until the next schedule change' }),
  zh: Object.freeze({ once: '仅一次', window: '至下次档位切换' }),
});

export { fill };