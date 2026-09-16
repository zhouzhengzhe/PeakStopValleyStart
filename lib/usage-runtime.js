/**
 * The host runtime behind the info bar: persistence, the model-stream hook, and the
 * balance cache.
 *
 * This is the only part of the feature that touches the outside world — the clock, the
 * filesystem, the network and the model stream — so it is deliberately thin. Everything
 * it decides is delegated to a pure module (`usage-ledger`, `price-table`, `info-bar-view`,
 * `usage-collect`), and what is left here is plumbing that can be read at a glance.
 *
 * Two properties it must never lose:
 *
 * **Saving is debounced and off the hot path.** The hook runs for every model call. A
 * synchronous write there would put a file system between the operator and the model.
 *
 * **Nothing here can break a model call.** Recording is wrapped; a failure costs a ledger
 * row and nothing else.
 *
 * @module peak-valley-brake/usage-runtime
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { harnessHome } from './hold-ledger.js';
import { buildInfoBar } from './info-bar-view.js';
import {
  balanceAfterFailure,
  balanceAfterSuccess,
  createBalanceState,
  requestDeepSeekBalance,
  shouldAttemptBalance,
  tapUsage,
} from './usage-collect.js';
import {
  LEDGER_VERSION,
  createLedgerState,
  pruneDays,
  reduceRecord,
  spendWindows,
  unpricedModels,
} from './usage-ledger.js';

/** Directory under the harness home that holds this plugin's usage ledger. */
export const USAGE_DIR_NAME = 'peak-valley-usage';

/** The ledger document's file name. Deliberately not the hold ledger's. */
export const USAGE_FILE_NAME = 'usage-ledger.json';

/** How long to coalesce ledger writes for. */
export const SAVE_DEBOUNCE_MS = 2_000;

/** How often the balance question is re-asked (the state machine decides whether to act). */
export const BALANCE_POLL_MS = 30_000;

/** Day buckets older than this are dropped, so the file cannot grow without bound. */
export const RETENTION_DAYS = 400;

/** Milliseconds per day, for the retention cutoff. */
const MS_PER_DAY = 86_400_000;

/**
 * Build the runtime.
 *
 * @param {object} [options] - collaborators and overrides.
 * @param {string} [options.home] - harness home override.
 * @param {() => number} [options.now] - the clock.
 * @param {(message: string) => void} [options.report] - where degraded paths are reported.
 * @param {(name: string) => Promise<string|undefined>} [options.resolveCredential] - credential lookup.
 * @param {Function} [options.fetchImpl] - fetch, injected for tests.
 * @param {(hookOptions: object) => string|undefined} [options.sessionIdFor] - the session a model call belongs to.
 * @param {(sessionId: string|undefined) => string} [options.modelFor] - the model name to display.
 * @returns {object} the runtime.
 */
export function createUsageRuntime(options = {}) {
  const now = options.now ?? (() => Date.now());
  const report = options.report ?? (() => {});
  const root = options.home ?? harnessHome();
  const file = join(root, USAGE_DIR_NAME, USAGE_FILE_NAME);

  /** @type {ReturnType<typeof createLedgerState>} */
  let ledger = createLedgerState();
  let balance = createBalanceState();
  let loaded = false;
  let disposed = false;
  let saveTimer;
  let balanceTimer;
  let lastModel = '';

  /**
   * Read the persisted ledger.
   *
   * A missing file is the ordinary first run. A corrupt or future-versioned file is
   * reported and replaced with an empty ledger rather than throwing: losing history is
   * much better than the plugin refusing to load and the brake going with it.
   *
   * @returns {Promise<void>} resolves once the attempt has finished.
   */
  const load = async () => {
    try {
      const text = await readFile(file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== LEDGER_VERSION) {
        report(`usage ledger has an unrecognised version; starting a fresh one`);
        return;
      }
      ledger = {
        version: LEDGER_VERSION,
        sessions: parsed.sessions ?? Object.create(null),
        days: parsed.days ?? Object.create(null),
        unpricedModels: Array.isArray(parsed.unpricedModels) ? parsed.unpricedModels : [],
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        report(`could not read the usage ledger: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      loaded = true;
    }
  };

  /**
   * Write the ledger out, replacing the previous file atomically.
   *
   * Written to a sibling and renamed so a crash mid-write cannot leave a half-document
   * that the next start would refuse. If the rename fails the temporary file is left
   * behind rather than deleted, because it holds the only copy of whatever was not yet
   * on disk.
   *
   * @returns {Promise<void>} resolves once the attempt has finished.
   */
  const save = async () => {
    try {
      await mkdir(join(root, USAGE_DIR_NAME), { recursive: true });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(ledger), 'utf8');
      await rename(temporary, file);
    } catch (error) {
      report(`could not save the usage ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Coalesce a burst of calls into one write. */
  const scheduleSave = () => {
    if (disposed || saveTimer !== undefined) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void save();
    }, SAVE_DEBOUNCE_MS);
    // A pending save must never hold the process open.
    saveTimer.unref?.();
  };

  /**
   * Record one call.
   * @param {object} record - the record from the stream tap.
   * @returns {void}
   */
  const record = (record) => {
    try {
      reduceRecord(ledger, record);
      if (record.model !== '') lastModel = record.model;
      scheduleSave();
    } catch (error) {
      report(`could not record a call: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Ask for the balance, if the state machine says it is time.
   * @returns {Promise<void>} resolves once the attempt has finished.
   */
  const refreshBalance = async () => {
    if (disposed || !shouldAttemptBalance(balance, now())) return;
    let apiKey;
    try {
      apiKey = await options.resolveCredential?.('DEEPSEEK_API_KEY');
    } catch (error) {
      balance = balanceAfterFailure(
        balance,
        { kind: 'no-credential', message: error instanceof Error ? error.message : String(error) },
        now(),
      );
      return;
    }
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      balance = balanceAfterFailure(
        balance,
        { kind: 'no-credential', message: 'no DEEPSEEK_API_KEY configured' },
        now(),
      );
      return;
    }
    const outcome = await requestDeepSeekBalance({ apiKey, fetchImpl: options.fetchImpl });
    balance = outcome.ok
      ? balanceAfterSuccess(balance, outcome.reading, now())
      : balanceAfterFailure(balance, { kind: outcome.kind, message: outcome.message }, now());
  };

  return {
    /** Load the ledger. Safe to call once at start-up. */
    load,

    /**
     * Register the model-stream hook and start the balance clock.
     *
     * @param {object} ctx - the host plugin context.
     * @returns {void}
     */
    attach(ctx) {
      ctx.on('llm/stream', async function* (hookOptions, next) {
        // Stamped when the call is initiated, which is the tier it will be billed at.
        const atMs = now();
        const sessionId = options.sessionIdFor?.(hookOptions);
        const model = hookOptions?.model ?? options.modelFor?.(sessionId) ?? lastModel;
        yield* tapUsage(
          async () => {
            try {
              return await next();
            } catch (error) {
              // Reported here rather than inside the tap: an upstream failure is not an
              // accounting event, and the tap must not turn it into one.
              report(`llm/stream could not start, this call is not billed: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
          },
          { atMs, model, sessionId },
          record,
        );
      });

      balanceTimer = setInterval(() => {
        void refreshBalance();
      }, BALANCE_POLL_MS);
      balanceTimer.unref?.();
      // One attempt straight away, so a bar on a fresh page has a figure rather than a dash.
      void refreshBalance();
    },

    /**
     * The info bar's data model for a session.
     *
     * @param {string} [sessionId] - the session, when one is known.
     * @returns {object} the view model.
     */
    viewFor(sessionId) {
      const at = now();
      return buildInfoBar({
        nowMs: at,
        model: options.modelFor?.(sessionId) ?? lastModel,
        providerName: 'DeepSeek',
        balance,
        windows: spendWindows(ledger, { nowMs: at, sessionId }),
        unpricedModels: unpricedModels(ledger),
      });
    },

    /** Drop day buckets past the retention window and write the result. */
    prune() {
      const dropped = pruneDays(ledger, now() - RETENTION_DAYS * MS_PER_DAY);
      if (dropped > 0) scheduleSave();
      return dropped;
    },

    /** Flush any pending write and stop the timers. */
    async dispose() {
      disposed = true;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = undefined;
      if (balanceTimer !== undefined) clearInterval(balanceTimer);
      balanceTimer = undefined;
    },

    /** The current balance state, for tests and diagnostics. */
    balanceState: () => balance,
    /** The current ledger, for tests and diagnostics. */
    ledgerState: () => ledger,
    /** Whether the persisted ledger has been read yet. */
    isLoaded: () => loaded,
    /** Ask for the balance now, ignoring the poll interval. */
    refreshBalance,
    /** The file this runtime persists to. */
    filePath: () => file,
  };
}
