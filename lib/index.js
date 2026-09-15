/**
 * Peak/valley dispatch brake for DeepSeek Harness.
 *
 * What it does: during DeepSeek's peak-rate windows it refuses to let new agent
 * steps enter, so no request is billed at peak price; when off-peak rates return
 * it puts the withheld work back and wakes the agent. Off-peak requests are
 * never modified — the guard is transparent whenever it is not holding.
 *
 * Why it refuses at the step boundary rather than cancelling the turn: the loop
 * executes tools *after* a step's model request, so a step boundary is the one
 * place where everything already started has finished and nothing new has been
 * paid for. `cancel()` would abort a turn mid-tool, which the objective
 * explicitly rules out.
 *
 * The load-bearing discovery behind this design: the loop claims a step's
 * messages out of the inbox *before* it asks `agent/pre-step`, and a rejected
 * step does not put them back (see `ReactLoopInbox.claim` and the `reject`
 * branch of the turn loop in `@deepseek-ai/dsh-agent-loop`). A naive brake
 * therefore silently destroys the user's prompt. This plugin copies the claimed
 * batch into a durable ledger before refusing, and re-delivers it at the
 * release instant.
 *
 * @module peak-valley-brake
 */

import { z } from 'zod';

import { createHoldLedger, summarizeMessage } from './hold-ledger.js';
import { resolveLanguage } from './locale.js';
import { OVERRIDE_LABELS, STATE_LABELS, dictionaryFor, render } from './messages.js';
import { dispatchVerdict, nextTransitionAfter, phaseAt } from './time-window.js';
import { captureFingerprint, changedPaths, compareFingerprints, renderDriftReport } from './workspace-drift.js';

/**
 * Load the harness message constructors.
 *
 * Imported lazily so this module stays loadable — for static analysis and for
 * the pure-logic tests — in an environment where the harness packages are not
 * on the module path. The host resolves them when the plugin is actually
 * mounted, in the same process as the harness.
 *
 * @returns {Promise<{createUserMessage: Function, boundContextSummary: Function}>} the constructors.
 */
const loadMessageApi = () => import('@deepseek-ai/dsh-llm');

/** Plugin name, matching the id declared in `cordis.patch.yml`. */
export const name = 'peak-valley-brake';

/**
 * Service dependencies.
 *
 * Two different kinds of dependency, declared two different ways:
 *
 *  - `commands` is declared **optional** — note the nullish value, which is how
 *    cordis marks a dependency that may legitimately be absent. A headless
 *    composition has no command surface, and the brake must still work there,
 *    so the dependency cannot be required.
 *  - `llm` is required, because message construction is not optional: the
 *    receipt and the drift notice are both built with `createUserMessage` from
 *    this package. Requiring it turns a missing dependency into a clear load
 *    failure instead of a runtime surprise at 01:00.
 *
 * Both must be declared at all: cordis refuses to resolve a service that was not
 * declared (`cannot get property "commands" without inject`), so a defensive
 * `ctx.commands === undefined` check is not enough on its own.
 */
export const inject = { commands: null, llm: { required: true } };

/**
 * Configuration contract.
 *
 * The loader validates this through the Standard Schema interface — cordis calls
 * `Config['~standard'].validate(raw)` and applies the returned defaults — so a
 * plain object literal here makes the profile fail to boot with an opaque
 * `Cannot read properties of undefined (reading 'validate')`. A zod schema
 * implements that interface directly, which is why the schema is the config.
 *
 * Every field has a default, so the plugin is useful with no configuration at
 * all. The wrapping `prefault({})` matters for the same reason: a profile row
 * without a `config:` key makes the loader validate `undefined`, and an object
 * schema alone rejects that with "expected object, received undefined" — which
 * would make the row impossible to add without also configuring it. `prefault`
 * substitutes `{}` *before* validation so the field defaults still apply;
 * `.default({})` would substitute *after* and hand back a hollow `{}`.
 */
const fields = {
  /** Master switch; when false the brake never holds. */
  enabled: z.boolean().default(true),
  /** Minutes before a peak window to stop dispatching. */
  brakeLeadMinutes: z.number().int().min(0).default(5),
  /** Minutes after a peak window before dispatching resumes. */
  releaseDelayMinutes: z.number().int().min(0).default(1),
  /** Hold prompts the operator typed. Regenerable wakes are always released. */
  holdUserMessages: z.boolean().default(true),
  /**
   * Check the workspace for external changes before re-delivering withheld work.
   *
   * A hold can last hours; a human editing a file in that window makes the
   * agent's remembered file contents wrong. When on, the brake measures the
   * workspace at hold time and again at release, and tells the model to re-read
   * whatever moved. The check is advisory — it never blocks the release.
   */
  verifyWorkspaceOnResume: z.boolean().default(true),
  /**
   * Allow the `/peak-valley` command to release held work early.
   *
   * The command itself is the only way to spend money at peak without editing
   * configuration and reloading, so this switch is the operator's guarantee that
   * no command can override their cost policy.
   */
  allowManualOverride: z.boolean().default(true),
  /**
   * Post a receipt in the conversation when a request is withheld.
   *
   * Without it a hold is indistinguishable from a hang, because nothing appears
   * in the transcript. With it the operator sees what happened and when it ends.
   */
  announceOnBrake: z.boolean().default(true),
  /**
   * Language for operator-facing text: `auto`, `zh`, or `en`.
   *
   * `auto` reads the harness's persisted UI language and falls back to the
   * operating system's, then to English. Set it explicitly to pin the language
   * regardless of what the machine reports.
   */
  locale: z.enum(['auto', 'zh', 'en']).default('auto'),
  /** Re-evaluation period, in seconds, when the table offers no future boundary. */
  releaseTickSeconds: z.number().int().min(1).default(30),
  /** Harness home override for the hold ledger; empty means `$DSH_HOME` or `~/.dsh`. */
  home: z.string().default(''),
  /**
   * Escape hatch for an official schedule change.
   *
   * The window table is built in, deliberately, so the guard behaves
   * predictably with no network. That leaves one risk: if DeepSeek changes the
   * windows, the built-in table is wrong until a new release ships. This option
   * replaces the table without one, as a JSON array of
   * `{ "weekdays": [1,2,3,4,5], "startMinute": 60, "durationMinutes": 180 }`.
   * An empty string keeps the official table.
   */
  peakWindowsOverride: z.string().default(''),
  /**
   * Also write guard decisions to stderr.
   *
   * The host's logger is not reliably visible in every launch mode, and "why was
   * my request held?" is the first question an operator asks. Setting this (or
   * `DSH_PEAK_VALLEY_BRAKE_DEBUG=1`) makes the guard's own account of itself
   * observable from the terminal that started the harness.
   */
  debug: z.boolean().default(false),
};

/** The validated field set, retained so callers and tests can enumerate it. */
export const ConfigShape = z.object(fields);

/** Configuration contract handed to the host loader. */
export const Config = ConfigShape.prefault({});

/** Longest timer delay a host will schedule without clamping, in milliseconds. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Normalize a raw configuration object into validated values.
 *
 * Validation is repeated here rather than trusted from the loader so that a
 * programmatic caller — a test, or an operator console — cannot bypass it, and
 * so a bad option fails at load with a clear message instead of at 01:00 with a
 * silently wrong schedule.
 *
 * @param {unknown} raw - raw configuration.
 * @returns {Readonly<object>} validated configuration.
 */
function normalizeConfig(raw) {
  const parsed = ConfigShape.safeParse(raw ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new TypeError(`peak-valley-brake: invalid configuration — ${detail}`);
  }
  return Object.freeze({
    ...parsed.data,
    // An explicit home keeps the ledger out of the real harness home, which
    // matters for tests and for operators who relocate their state.
    home: parsed.data.home.trim() === '' ? undefined : parsed.data.home,
    windows: parseWindowOverride(parsed.data.peakWindowsOverride),
  });
}

/**
 * Parse the `peakWindowsOverride` escape hatch into a window table.
 *
 * Fails loudly on malformed input rather than silently falling back to the
 * official table: an operator who has just learned the windows changed must not
 * be left believing an override took effect when it did not.
 *
 * @param {string} raw - JSON array text, or an empty string for the official table.
 * @returns {readonly object[]|undefined} the override table, or `undefined` to use the official one.
 */
function parseWindowOverride(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `peak-valley-brake: peakWindowsOverride is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError('peak-valley-brake: peakWindowsOverride must be a non-empty JSON array');
  }
  return Object.freeze(
    parsed.map((entry, index) => {
      const at = `peakWindowsOverride[${index}]`;
      if (entry === null || typeof entry !== 'object') throw new TypeError(`peak-valley-brake: ${at} must be an object`);
      const { weekdays, startMinute, durationMinutes } = entry;
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        throw new TypeError(`peak-valley-brake: ${at}.weekdays must be a non-empty array of 0-6`);
      }
      for (const weekday of weekdays) {
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          throw new TypeError(`peak-valley-brake: ${at}.weekdays entries must be integers 0-6 (0=Sunday)`);
        }
      }
      if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439) {
        throw new TypeError(`peak-valley-brake: ${at}.startMinute must be an integer 0-1439 (UTC minute of day)`);
      }
      if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || startMinute + durationMinutes > 1440) {
        throw new TypeError(`peak-valley-brake: ${at}.durationMinutes must keep the window inside one UTC day`);
      }
      return Object.freeze({
        weekdays: Object.freeze([...weekdays]),
        startMinute,
        endMinute: startMinute + durationMinutes,
        durationMinutes,
      });
    }),
  );
}

/**
 * Install the brake.
 *
 * @param {object} ctx - the host plugin context.
 * @param {object} [rawConfig] - loader-supplied configuration.
 * @returns {{releaseNow: () => Promise<void>, phaseNow: () => object, heldSessions: () => string[]}} a control surface.
 *   The host ignores the return value; a test or an operator console uses it to
 *   drive a release without waiting for the wall clock to reach a boundary.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger ?? console;
  /**
   * Operator-facing text table, resolved once per load.
   *
   * Starts as English so every message is renderable immediately; the resolved
   * language replaces it as soon as the asynchronous lookup settles. Resolution
   * never rejects, so this is a swap rather than a failure path.
   */
  let text = dictionaryFor('en');
  let languageSource = 'pending';
  /** Whether guard decisions should also reach the terminal that launched the host. */
  const debugToStderr = config.debug || process.env.DSH_PEAK_VALLEY_BRAKE_DEBUG === '1';
  /**
   * Harness message constructors, resolved once.
   *
   * Held until the first use rather than awaited at load, so a failure to
   * resolve them degrades one feature instead of refusing the whole plugin.
   *
   * @type {Promise<{createUserMessage: Function, boundContextSummary: Function}>|undefined}
   */
  let messageApi;
  /** Per-session brake state. Keyed by session id. */
  const states = new Map();
  /**
   * The live manual override, when one has been granted.
   *
   * Deliberately process-local and never persisted: an override must not survive
   * a restart, because the whole point of a brake is that it re-arms by itself.
   * An operator who wants peak dispatching again can always ask again.
   *
   * @type {{kind: 'once'|'window', untilMs: number, requestedBy: string, requestedAtMs: number}|undefined}
   */
  let activeOverride;
  const ledger = createHoldLedger({
    ...(config.home === undefined ? {} : { home: config.home }),
    report: (event) => logger.warn?.(`[${name}] ${event.code}: ${event.message}`),
  });

  /** Diagnostics sink that never throws into the host. */
  const warn = (message) => {
    const line = `[${name}] ${message}`;
    try {
      logger.warn?.(line);
    } catch {
      /* a logging failure must not break the guard */
    }
    if (debugToStderr) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* stderr may be closed under a detached launcher */
      }
    }
  };

  /**
   * Current schedule options, read fresh so a settings change takes effect at
   * the next judgement rather than at the next restart.
   */
  const scheduleOptions = () => ({
    brakeLeadMinutes: config.brakeLeadMinutes,
    releaseDelayMinutes: config.releaseDelayMinutes,
    ...(config.windows === undefined ? {} : { windows: config.windows }),
  });

  /** Read or create one session's state record. */
  const stateFor = (agent) => {
    const key = String(agent.id);
    let state = states.get(key);
    if (state === undefined) {
      // Two distinct records, deliberately:
      //  - `inserted` observes every message that enters the inbox, so a claimed
      //    batch can still be described after the loop takes it away.
      //  - `held` keeps the verbatim objects the brake withheld, which is what
      //    re-delivery needs. The ledger covers surviving a restart; this map
      //    covers delivering the original text within one process lifetime.
      //  - `fingerprint` is the workspace baseline for the current hold window,
      //    cleared on delivery so the next window measures afresh.
      state = {
        agent,
        inserted: new Map(),
        held: new Map(),
        fingerprint: undefined,
        delivery: undefined,
        receiptShown: false,
      };
      states.set(key, state);
    }
    state.agent = agent;
    return state;
  };

  /**
   * Decide whether the brake currently holds dispatch.
   *
   * A live manual override wins over the schedule and is reported as its own
   * reason, so an operator reading a log can always tell a deliberate exception
   * apart from a bug in the window table.
   *
   * @returns {{hold: boolean, reason: string, phase: object}} the verdict.
   */
  const verdictNow = () => {
    const phase = phaseAt(Date.now(), scheduleOptions());
    if (!config.enabled) return { hold: false, reason: 'disabled', phase };
    if (config.allowManualOverride && isOverrideLive()) {
      return { hold: false, reason: 'manual-override', phase };
    }
    return dispatchVerdict(Date.now(), scheduleOptions());
  };

  /**
   * Whether a granted override still covers the current instant.
   *
   * A `once` override covers exactly one turn and is cleared as it is spent; a
   * `window` override covers every turn until a schedule boundary, which is what
   * bounds it — it cannot silently outlive the peak window it was granted in.
   *
   * @returns {boolean} whether dispatch is currently released by an override.
   */
  const isOverrideLive = () => {
    const override = activeOverride;
    if (override === undefined) return false;
    if (override.kind === 'once') return true;
    if (Date.now() >= override.untilMs) {
      activeOverride = undefined;
      return false;
    }
    return true;
  };

  /**
   * Grant a manual override.
   *
   * @param {'once'|'window'} kind - `once` covers one turn, `window` covers the current schedule block.
   * @param {string} sessionId - the session whose operator asked for it, for the audit record.
   * @returns {{untilMs: number, blockEndsAtMs: number}} the granted window.
   */
  const grantOverride = (kind, sessionId) => {
    const nowMs = Date.now();
    // A schedule boundary is the natural expiry: the override cannot outlive the
    // peak window it was granted in, and the guard re-arms itself afterwards.
    const boundary = nextTransitionAfter(nowMs, scheduleOptions());
    const untilMs = boundary === undefined ? nowMs + 60_000 : boundary.instantMs;
    activeOverride = { kind, untilMs, requestedBy: sessionId, requestedAtMs: nowMs };
    warn(
      `manual override granted (${kind}) by ${sessionId}; dispatching until ${new Date(untilMs).toISOString()}`,
    );
    return { untilMs, blockEndsAtMs: untilMs };
  };

  /** Drop any live override, returning the guard to the schedule. */
  const clearOverride = () => {
    const had = activeOverride !== undefined;
    activeOverride = undefined;
    if (had) warn('manual override cancelled; the schedule governs dispatch again');
    return had;
  };

  /**
   * Turn a claimed batch into ledger records.
   * @param {object[]} messages - messages the loop just claimed.
   * @param {Map<string, object>} inserted - messages observed on insertion.
   * @returns {object[]} held records for the ledger.
   */
  const recordsFor = (messages, inserted) =>
    messages.map((message) => ({
      id: String(message.id),
      role: String(message.role ?? 'user'),
      source: String(message.source?.kind ?? 'unknown'),
      summary: summarizeMessage(inserted.get(String(message.id)) ?? message),
    }));

  /**
   * Whether a claimed message is work this brake must preserve.
   *
   * User-authored messages are always preserved: dropping them would lose the
   * operator's words. Every other origin (goal rounds, schedule reminders,
   * plugin context) is regenerated by its owner, so the brake lets those go —
   * holding them would fight the very driver that will re-issue them.
   *
   * @param {object} message - a claimed message.
   * @returns {boolean} whether to hold it.
   */
  const shouldHold = (message) => {
    const kind = message.source?.kind;
    if (!config.holdUserMessages) return false;
    return kind === 'user';
  };

  /**
   * Resolve the operator-facing language, once, without ever failing the load.
   * @returns {Promise<void>} resolution after the swap.
   */
  const resolveText = async () => {
    try {
      const { language, source } = await resolveLanguage({ configured: config.locale, home: config.home });
      text = dictionaryFor(language);
      languageSource = source;
    } catch {
      languageSource = 'fallback';
    }
  };

  /**
   * Read the harness message constructors, once.
   *
   * Using the harness's own constructors matters: they mint the branded message
   * identity every consumer expects, which a hand-assembled object cannot.
   *
   * @returns {Promise<{createUserMessage: Function, boundContextSummary: Function}>} the constructors.
   */
  const messageApiNow = () => {
    messageApi ??= loadMessageApi();
    return messageApi;
  };

  /**
   * Build the operator-facing receipt for a hold.
   *
   * This is what makes the brake visible in the conversation. The message is
   * model-facing context rather than a chat message, so it appears in the
   * transcript without being mistaken for something the operator said, and it is
   * `inject`ed rather than `followup`ed — a follow-up would wake the driver and
   * be refused by this very brake.
   *
   * @param {number} count - how many messages were withheld.
   * @param {{releaseMs: number, state: string}} phase - the schedule classification at hold time.
   * @param {Function} createUserMessage - the harness constructor.
   * @param {Function} boundContextSummary - the harness summary bounder.
   * @returns {object} the receipt message.
   */
  const buildReceipt = (count, phase, createUserMessage, boundContextSummary) => {
    const releaseUtc = new Date(phase.releaseMs).toISOString().replace('T', ' ').slice(0, 16);
    const releaseLocal = new Date(phase.releaseMs + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16);
    const values = { count, releaseUtc, releaseLocal, state: STATE_LABELS.en[phase.state] ?? phase.state };
    return createUserMessage({
      content: [{ type: 'text', text: render(text, 'receipt.body', values) }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: boundContextSummary(render(text, 'receipt.summary', values)),
      },
    });
  };

  /**
   * Read the workspace a session is running in.
   *
   * The session header owns this; it is absent for sessions created without a
   * working directory, which the drift check then reports as unverified rather
   * than guessing at one.
   *
   * @param {object} agent - the agent whose session to inspect.
   * @returns {string|undefined} absolute workspace directory.
   */
  const workspaceOf = (agent) => {
    const cwd = agent.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
  };

  /**
   * Measure the workspace for drift detection, or `undefined` when disabled.
   * @param {object} agent - the agent whose workspace to measure.
   * @returns {Promise<object|undefined>} the fingerprint.
   */
  const measureWorkspace = async (agent) => {
    if (!config.verifyWorkspaceOnResume) return undefined;
    return captureFingerprint(workspaceOf(agent) ?? '');
  };

  /**
   * Compare the workspace now against the measurement taken when work was held.
   *
   * @param {object} agent - the agent whose workspace to inspect.
   * @param {object} batch - the ledger batch being delivered.
   * @returns {Promise<string[]>} zero or one notice, ready to prepend to the work.
   */
  const driftNotices = async (agent, batch) => {
    if (!config.verifyWorkspaceOnResume) return [];
    const cwd = batch.cwd ?? workspaceOf(agent);
    // A session with no working directory has no files to go stale: saying
    // "I could not check your workspace" there would be pure noise on every
    // delivery, so the check stays silent unless there is a workspace to check.
    if (cwd === undefined) return [];
    const after = await captureFingerprint(cwd);
    const comparison = compareFingerprints(batch.fingerprint, after);
    if (comparison.status === 'drifted') {
      comparison.paths = await changedPaths(cwd, batch.fingerprint, after);
      warn(`workspace drift detected before re-delivery: ${comparison.reasons.join('; ')}`);
    } else if (comparison.status === 'unverified') {
      warn(`workspace could not be verified before re-delivery: ${comparison.reasons.join('; ')}`);
    }
    const report = renderDriftReport(comparison, text);
    return report === undefined ? [] : [report];
  };

  /**
   * Prepend advisory notices to a re-delivered message without mutating it.
   *
   * The original object is owned by the session and may be frozen, so the notice
   * goes into a new message built by the harness constructor. Re-delivering the
   * same text under a new id is safe here because the original was never
   * committed to the session log — a rejected step does not record its claimed
   * messages.
   *
   * @param {object} message - the original message.
   * @param {string[]} notices - notices to prepend.
   * @returns {Promise<object>} the original message, or a copy carrying the notices.
   */
  const attachWarning = async (message, notices) => {
    if (notices.length === 0) return message;
    const { createUserMessage } = await messageApiNow();
    return createUserMessage({
      content: [...notices.map((text) => ({ type: 'text', text })), ...(Array.isArray(message.content) ? message.content : [])],
      source: { kind: 'user' },
    });
  };

  /**
   * Re-deliver a session's held batch and wake its agent.
   *
   * Called only when dispatch is open, so the re-delivered messages are claimed
   * for real this time. The first message is sent through `agent.send`, which is
   * the public delivery path that can wake the driver; the rest are appended so
   * the batch keeps its original order. `agent.inbox.append` deliberately does
   * not wake, so a batch re-parked without a waking delivery would sit unclaimed.
   *
   * @param {object} state - session state record.
   * @param {object} agent - the agent to wake.
   * @returns {Promise<boolean>} whether anything was delivered.
   */
  const deliverHeld = async (state, agent) => {
    const key = String(agent.id);
    // Serialize deliveries per session. Clearing the ledger makes a *sequential*
    // second pass a no-op, but it cannot stop two concurrent passes — the command
    // path and the timer path can overlap — from both reading the same batch
    // before either clears it, which would deliver the operator's prompt twice.
    const previous = state.delivery ?? Promise.resolve();
    const run = previous.then(
      () => deliverHeldOnce(state, agent),
      () => deliverHeldOnce(state, agent),
    );
    state.delivery = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Perform one delivery attempt for a session's held batch.
   * @param {object} state - session state record.
   * @param {object} agent - the agent to deliver to.
   * @returns {Promise<boolean>} whether anything was delivered.
   */
  const deliverHeldOnce = async (state, agent) => {
    const key = String(agent.id);
    const loaded = await ledger.load(key);
    if (!loaded.ok) {
      warn(`cannot read held work for ${key}: ${loaded.message}; leaving it for the next attempt`);
      return false;
    }
    const batch = loaded.batch;
    if (batch === undefined || batch.messages.length === 0) return false;

    const verdict = verdictNow();
    if (verdict.hold) return false;

    // Audit: record when a deliberate override released work that the schedule
    // says should still be held. Skipping cost policy is the operator's call to
    // make, not one to make invisibly. The record goes to the append-only audit
    // file, not the ledger, because the ledger is cleared by this very delivery.
    const override = activeOverride;
    if (override !== undefined && verdict.phase.state !== 'open') {
      const audited = await ledger.appendOverrideAudit({
        sessionId: key,
        kind: override.kind,
        grantedAtMs: override.requestedAtMs,
        grantedBy: override.requestedBy,
        usedAtMs: Date.now(),
        phaseAtUse: verdict.phase.state,
        messagesReleased: batch.messages.length,
      });
      if (!audited.ok) warn(`could not record the override audit trail (${audited.code})`);
    }

    // Drift is advisory: it adds a caveat to the work, and never withholds it.
    const notices = await driftNotices(agent, batch);

    const restored = [];
    for (const record of batch.messages) {
      const original = state.held.get(record.id);
      if (original === undefined) {
        // The verbatim message is gone (host restart between park and release).
        // Rebuild it from the ledger summary so the operator's intent survives,
        // and say plainly that it is a reconstruction.
        restored.push(await reconstruction(record, notices));
        continue;
      }
      restored.push(await attachWarning(original, notices));
    }
    if (restored.length === 0) return false;
    let delivered = 0;
    for (const [index, message] of restored.entries()) {
      try {
        if (index === 0) agent.send(message, 'next-turn', true);
        else agent.inbox.append('next-turn', message);
        delivered += 1;
      } catch (error) {
        warn(`re-delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Only clear the ledger once the batch is genuinely back in the inbox; a
    // failed delivery must remain recoverable on the next release pass.
    if (delivered === restored.length) {
      for (const record of batch.messages) state.held.delete(record.id);
      // Start the next hold window with a fresh baseline.
      state.fingerprint = undefined;
      const cleared = await ledger.clear(key);
      if (!cleared.ok) warn(`held batch for ${key} was delivered but the ledger could not be cleared: ${cleared.message}`);
    } else {
      warn(`only ${delivered} of ${restored.length} held message(s) were re-delivered; keeping the ledger for the next attempt`);
    }
    return delivered > 0;
  };

  /**
   * Rebuild a held message whose verbatim copy is no longer in memory.
   *
   * The reconstruction is explicitly labelled so neither the model nor the
   * operator can mistake it for the original text. Losing the exact wording
   * across a restart is a real limitation; silently dropping the work instead
   * would be worse. Any drift report is folded into the same message, so the
   * model reads the caveat next to the work it applies to.
   *
   * @param {{id: string, summary: string}} record - the ledger record.
   * @param {string[]} notices - extra text to prepend.
   * @returns {Promise<object>} a user message carrying the summary.
   */
  const reconstruction = async (record, notices = []) => {
    const { createUserMessage } = await messageApiNow();
    return createUserMessage({
      content: [
        ...notices.map((value) => ({ type: 'text', text: value })),
        { type: 'text', text: render(text, 'reconstruction', { summary: record.summary }) },
      ],
      source: { kind: 'user' },
    });
  };

  /** Re-evaluate every known session and deliver whatever is now allowed. */
  const releaseAll = async () => {
    const verdict = verdictNow();
    const override = activeOverride;
    if (!verdict.hold) {
      for (const state of states.values()) {
        try {
          await deliverHeld(state, state.agent);
        } catch (error) {
          warn(`release pass failed for ${String(state.agent.id)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    // A one-shot override covers one whole release pass, not one session: it is
    // spent here, after every session that had held work has been served.
    if (override !== undefined && override.kind === 'once' && activeOverride === override) {
      activeOverride = undefined;
      warn('one-shot manual override spent');
    }
    armSharedTimer();
  };

  /**
   * One shared timer for the whole plugin, re-armed at each schedule boundary.
   *
   * A single timer is enough because the schedule is global: every session's
   * release instant comes from the same table. Re-arming on each tick also makes
   * the guard immune to wall-clock jumps, since the delay is recomputed from the
   * current time rather than accumulated.
   */
  let sharedTimer;
  const armSharedTimer = () => {
    if (sharedTimer !== undefined) clearTimeout(sharedTimer);
    const boundary = nextTransitionAfter(Date.now(), scheduleOptions());
    const delayMs =
      boundary === undefined
        ? config.releaseTickSeconds * 1000
        : Math.max(500, Math.min(MAX_TIMER_DELAY_MS, boundary.instantMs - Date.now() + 500));
    sharedTimer = setTimeout(() => {
      void releaseAll();
    }, delayMs);
    if (typeof sharedTimer.unref === 'function') sharedTimer.unref();
  };

  /**
   * Remember every message that enters an inbox, so the brake can re-deliver a
   * batch verbatim after the loop claims it away.
   *
   * @param {object} payload - the `agent/inbox/inserted` payload.
   * @returns {void}
   */
  const onInserted = (payload) => {
    const state = stateFor(payload.agent);
    state.inserted.set(String(payload.message.id), payload.message);
    // Bound the memory: a long session would otherwise retain every prompt ever sent.
    if (state.inserted.size > 256) {
      const oldest = state.inserted.keys().next();
      if (!oldest.done) state.inserted.delete(oldest.value);
    }
  };

  /**
   * The brake itself: refuse a step while dispatch is priced at peak.
   *
   * @param {object} payload - the `agent/pre-step` payload.
   * @param {() => Promise<object>} next - the downstream decision.
   * @returns {Promise<object>} the decision to enter or reject.
   */
  const onPreStep = async (payload, next) => {
    const verdict = verdictNow();
    if (!verdict.hold) return next();

    const { agent, messages } = payload;
    const state = stateFor(agent);
    const held = Array.isArray(messages) ? messages.filter(shouldHold) : [];

    if (held.length > 0) {
      const nowMs = Date.now();
      // Measure once per hold window. Re-measuring on every refusal would move
      // the baseline to the last wake, so a human's edit made just after the
      // brake engaged would be absorbed into the baseline and never reported.
      state.fingerprint ??= await measureWorkspace(agent);
      const saved = await ledger.save({
        sessionId: String(agent.id),
        parkedAtMs: nowMs,
        reason: verdict.reason,
        releaseAtMs: verdict.phase.releaseMs,
        messages: recordsFor(held, state.inserted),
        ...(workspaceOf(agent) === undefined ? {} : { cwd: workspaceOf(agent) }),
        ...(state.fingerprint === undefined ? {} : { fingerprint: state.fingerprint }),
      });
      if (!saved.ok) {
        // Fail open: refusing here would destroy work we could not preserve.
        warn(`held work could not be recorded (${saved.code}); allowing this step so the prompt is not lost`);
        return next();
      }
      for (const message of held) {
        state.held.set(String(message.id), message);
        state.inserted.delete(String(message.id));
      }
      // Tell the operator, in the conversation, that their message was withheld
      // and when it returns. Shown once per hold window: a receipt per wake would
      // turn a quiet wait into a wall of duplicate notices.
      if (config.announceOnBrake && !state.receiptShown) {
        try {
          const { createUserMessage, boundContextSummary } = await messageApiNow();
          agent.inject(buildReceipt(held.length, verdict.phase, createUserMessage, boundContextSummary));
          state.receiptShown = true;
        } catch (error) {
          // A missing receipt is a visibility gap, not a reason to lose the work.
          warn(`could not post the hold receipt: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      warn(render(text, 'log.holding', {
        count: held.length,
        untilUtc: new Date(verdict.phase.releaseMs).toISOString(),
        reason: verdict.reason,
      }));
    }

    // A wake with nothing worth holding is refused too: refusing still stops the
    // request, and the loop's own wake latch keeps ownership of retrying.
    return { kind: 'reject' };
  };

  /**
   * Restore a session's held batch when its log is resumed after a restart.
   *
   * @param {object} payload - the `agent/session-start` payload.
   * @returns {void}
   */
  const onSessionStart = (payload) => {
    const state = stateFor(payload.agent);
    void (async () => {
      const loaded = await ledger.load(String(payload.agent.id));
      if (!loaded.ok || loaded.batch === undefined) return;
      warn(
        `session resumed with ${loaded.batch.messages.length} held message(s) from ${new Date(loaded.batch.parkedAtMs).toISOString()}`,
      );
      if (!verdictNow().hold) await deliverHeld(state, payload.agent);
    })();
  };

  /** Start guarding, and keep the timer armed. */
  const onCreated = (payload) => {
    const agent = payload.agent;
    stateFor(agent);
    const scoped = agent.ctx ?? ctx;
    try {
      scoped.on('agent/pre-step', onPreStep);
      scoped.on('agent/inbox/inserted', onInserted);
      scoped.on('agent/session-start', onSessionStart);
    } catch (error) {
      warn(`could not install listeners on ${String(agent.id)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  ctx.on('agent/created', onCreated);
  armSharedTimer();

  void resolveText().then(() => {
    const initial = phaseAt(Date.now(), scheduleOptions());
    warn(
      render(text, 'log.started', {
        state: STATE_LABELS[text.language]?.[initial.state] ?? initial.state,
        lead: config.brakeLeadMinutes,
        delay: config.releaseDelayMinutes,
      }),
    );
  });

  /**
   * Register the operator's control surface.
   *
   * A slash command, not a model tool, and that choice is forced by the design:
   * the brake refuses a step *before* the model runs, so a tool the model could
   * call is unreachable exactly when it is needed. Harness commands run straight
   * against the agent with no model message and no token cost, which makes them
   * the only entry point that still works while dispatch is held.
   *
   * Registration is best-effort: a headless composition has no command surface,
   * and the brake must still work there.
   */
  const registerCommand = () => {
    const commands = probeCommands();
    if (commands === undefined || typeof commands.register !== 'function') {
      warn('no command surface in this composition; use the config switch to change cost policy');
      return;
    }
    try {
      commands.register({
        name: 'peak-valley',
        description: 'Show peak/valley status, or release held work now with an audited override',
        input: { hint: '[status | now | window | cancel]' },
        handler: ({ agent, rawInput }) => commandHandler(agent, rawInput),
      });
    } catch (error) {
      // A duplicate name means another instance owns the command; the brake must
      // still guard, so this stays a warning rather than a load failure.
      warn(`could not register the /peak-valley command: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Read the command service, tolerating a composition that does not provide it.
   *
   * The declaration in {@link inject} makes the property resolvable, but a
   * service can still be unavailable in an inactive context, and cordis signals
   * that by throwing. Probing keeps that from becoming a load failure.
   *
   * @returns {object|undefined} the command service, when present.
   */
  const probeCommands = () => {
    try {
      return ctx.commands;
    } catch {
      return undefined;
    }
  };

  /**
   * Answer one `/peak-valley` invocation.
   *
   * @param {object} agent - the agent the command was addressed to.
   * @param {string} rawInput - everything after the command name.
   * @returns {Promise<{kind: 'success'|'error', text: string}>} the rendered result.
   */
  const commandHandler = async (agent, rawInput) => {
    const subcommand = String(rawInput ?? '').trim().toLowerCase() || 'status';
    const nowMs = Date.now();
    const verdict = verdictNow();
    const upcoming = nextTransitionAfter(nowMs, scheduleOptions());
    const T = 'command';
    const stateLabel = STATE_LABELS[text.language]?.[verdict.phase.state] ?? verdict.phase.state;

    if (subcommand === 'status') {
      const held = await ledger.load(String(agent.id));
      const count = held.ok && held.batch !== undefined ? held.batch.messages.length : 0;
      const overrideValue =
        activeOverride === undefined
          ? render(text, `${T}.statusOverrideNone`)
          : render(text, `${T}.statusOverride`, {
              kind: OVERRIDE_LABELS[text.language]?.[activeOverride.kind] ?? activeOverride.kind,
              untilUtc: new Date(activeOverride.untilMs).toISOString().replace('T', ' ').slice(0, 16),
            });
      return {
        kind: 'success',
        text: [
          render(text, `${T}.statusSchedule`, { state: stateLabel, phase: verdict.phase.phase }),
          render(text, verdict.hold ? `${T}.statusDispatchHeld` : `${T}.statusDispatchOpen`, {
            reason: verdict.reason,
          }),
          upcoming === undefined
            ? render(text, `${T}.statusNextNone`)
            : render(text, `${T}.statusNext`, {
                edge: upcoming.edge,
                atUtc: new Date(upcoming.instantMs).toISOString().replace('T', ' ').slice(0, 16),
              }),
          render(text, `${T}.statusRelease`, {
            atUtc: new Date(verdict.phase.releaseMs).toISOString().replace('T', ' ').slice(0, 16),
          }),
          render(text, `${T}.statusHeldCount`, { count }),
          render(text, `${T}.statusOverrideLine`, {
            value: config.allowManualOverride ? overrideValue : render(text, `${T}.statusOverrideDisabled`),
          }),
        ].join('\n'),
      };
    }

    if (!config.allowManualOverride) {
      return { kind: 'error', text: render(text, `${T}.overrideDisabled`) };
    }

    if (subcommand === 'now' || subcommand === 'window') {
      const kind = subcommand === 'now' ? 'once' : 'window';
      const granted = grantOverride(kind, String(agent.id));
      // Answer first, release second: the operator gets immediate feedback and
      // nothing about the delivery can make the command look failed.
      queueMicrotask(() => {
        void releaseAll();
      });
      return {
        kind: 'success',
        text: render(text, kind === 'once' ? `${T}.grantedOnce` : `${T}.grantedWindow`, {
          untilUtc: new Date(granted.untilMs).toISOString().replace('T', ' ').slice(0, 16),
        }),
      };
    }

    if (subcommand === 'cancel') {
      return {
        kind: 'success',
        text: render(text, clearOverride() ? `${T}.cancelled` : `${T}.cancelNoop`),
      };
    }

    return { kind: 'error', text: render(text, `${T}.unknownSubcommand`, { subcommand }) };
  };

  registerCommand();

  // Teardown: the host disposes this plugin's context on unload, and a stray
  // timer must not outlive it.
  ctx.on('dispose', () => {
    if (sharedTimer !== undefined) clearTimeout(sharedTimer);
    states.clear();
  });

  return {
    /** Run one release pass immediately, exactly as the schedule timer would. */
    releaseNow: () => releaseAll(),
    /** Read the current classification without side effects. */
    phaseNow: () => phaseAt(Date.now(), scheduleOptions()),
    /** List the sessions this instance is tracking. */
    heldSessions: () => [...states.keys()],
    /** Grant a manual override directly, as the `/peak-valley` command does. */
    overrideNow: (kind, sessionId) => grantOverride(kind, sessionId ?? 'control-surface'),
    /** Drop a live manual override. */
    cancelOverride: () => clearOverride(),
    /** Whether a manual override currently releases dispatch. */
    isOverrideLive: () => isOverrideLive(),
    /** Run the command handler directly, for tests and operator consoles. */
    runCommand: (agent, rawInput) => commandHandler(agent, rawInput),
    /** Whether this composition exposes a command surface. */
    hasCommandSurface: () => probeCommands() !== undefined,
  };
}
