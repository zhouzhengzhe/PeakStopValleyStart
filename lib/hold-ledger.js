/**
 * Durable ledger of work the brake took off the inbox.
 *
 * Why this file exists at all: the agent loop *claims* a step's messages out of
 * the inbox before it asks any plugin whether the step may enter, and a
 * rejected step does not put them back (`ReactLoopInbox.claim` in
 * `@deepseek-ai/dsh-agent-loop`, then `if (decision.kind === 'reject') return
 * decision` in the turn loop). The claimed messages are therefore gone from both
 * the inbox and the session log. Holding a request without losing the user's
 * work means keeping our own copy, and "durable" has to include surviving a
 * host restart — an in-memory copy would silently drop the work on restart.
 *
 * The ledger is deliberately dumb: one JSON document per session, written with
 * an atomic replace, holding only what is needed to re-deliver the batch. Every
 * failure path degrades to "no ledger" and is reported to the caller, because a
 * persistence fault must never be what keeps a user's work out of their session.
 *
 * @module peak-valley-brake/hold-ledger
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Directory name under the DeepSeek Harness home that this plugin owns. */
const LEDGER_DIR_NAME = 'peak-valley-brake';
/** File-name suffix; one file per session. */
const LEDGER_SUFFIX = '.holds.json';
/** Append-only audit file for manual overrides, shared by every session. */
const OVERRIDE_AUDIT_FILE = 'overrides.ndjson';
/**
 * Append-only record of re-delivery attempts and their outcomes.
 *
 * Exists because a failed re-delivery is invisible to the operator: the message
 * simply never arrives, and the only trace was a host log line they cannot see.
 * "The release command said it was releasing and then nothing happened" is not a
 * diagnosable report, so this file turns it into one.
 */
const DELIVERY_LOG_FILE = 'delivery.ndjson';
/** Schema version of the ledger document, so a future reader can refuse politely. */
const LEDGER_VERSION = 1;

/**
 * Resolve the harness home directory.
 *
 * `$DSH_HOME` is the documented override; otherwise the default is `~/.dsh`,
 * matching `@deepseek-ai/dsh-home-paths`. The value is resolved here rather than
 * imported so this module has no runtime dependency on a package the host may
 * not expose to plugins, and so it stays unit-testable with an explicit home.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute harness home path.
 */
export function harnessHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  return join(homedir(), '.dsh');
}

/**
 * @typedef {object} HeldMessage
 * @property {string} id - the message identity the loop claimed.
 * @property {string} role - message role, always `user` for held work.
 * @property {string} source - coarse origin label (`user`, `goal`, `plugin`, …).
 * @property {string} summary - first line of the message text, for the receipt.
 */

/**
 * @typedef {object} HeldBatch
 * @property {string} sessionId - owning session identity.
 * @property {number} parkedAtMs - when the batch was taken off the inbox.
 * @property {string} reason - why dispatch was held (`peak`, `pre-peak-brace`, …).
 * @property {number} releaseAtMs - the instant the batch becomes deliverable.
 * @property {HeldMessage[]} messages - the claimed messages, in original order.
 * @property {string} [cwd] - workspace the session was running in, when known.
 * @property {object} [fingerprint] - workspace measurement taken at hold time, used to detect drift before re-delivery.
 */

/**
 * Filesystem-backed ledger with an in-process write queue per session.
 *
 * @param {object} [options] - construction options.
 * @param {string} [options.home] - harness home override; defaults to {@link harnessHome}.
 * @param {(event: {level: 'warn', code: string, message: string}) => void} [options.report] - sink for degraded-path diagnostics.
 */
export function createHoldLedger(options = {}) {
  const root = options.home ?? harnessHome();
  const report = options.report ?? (() => {});
  /** Serializes writes per session so two parks cannot interleave into one file. */
  const queues = new Map();

  /** Absolute path of one session's ledger file. */
  const fileFor = (sessionId) => join(root, LEDGER_DIR_NAME, `${encodeURIComponent(sessionId)}${LEDGER_SUFFIX}`);

  /**
   * Run one filesystem operation after any pending operation for the same session.
   * @param {string} sessionId - session whose queue to join.
   * @param {() => Promise<unknown>} work - operation to run.
   * @returns {Promise<unknown>} the operation's result.
   */
  const enqueue = (sessionId, work) => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  return {
    /**
     * Persist the batch currently held for a session, replacing any previous one.
     *
     * @param {HeldBatch} batch - the batch to record.
     * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>} the outcome.
     */
    async save(batch) {
      return enqueue(batch.sessionId, async () => {
        const file = fileFor(batch.sessionId);
        // `fingerprint` and `cwd` are optional; spreading the batch keeps the
        // document shape owned by the caller rather than duplicated here.
        const document = JSON.stringify({ version: LEDGER_VERSION, ...batch }, undefined, 2);
        try {
          await mkdir(dirname(file), { recursive: true });
          const temporary = `${file}.${process.pid}.tmp`;
          await writeFile(temporary, document, 'utf8');
          await rename(temporary, file);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report({ level: 'warn', code: 'ledger-write-failed', message });
          return { ok: false, code: 'ledger-write-failed', message };
        }
      });
    },

    /**
     * Read the batch recorded for a session.
     *
     * A missing file is a normal empty result. A malformed or future-version
     * document is reported and treated as empty, because guessing at a shape this
     * build does not understand is worse than starting clean.
     *
     * @param {string} sessionId - session to read.
     * @returns {Promise<{ok: true, batch: HeldBatch | undefined} | {ok: false, code: string, message: string}>} the outcome.
     */
    async load(sessionId) {
      return enqueue(sessionId, async () => {
        try {
          const raw = await readFile(fileFor(sessionId), 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object') throw new TypeError('ledger document is not an object');
          if (parsed.version !== LEDGER_VERSION) throw new TypeError(`unsupported ledger version ${String(parsed.version)}`);
          if (!Array.isArray(parsed.messages)) throw new TypeError('ledger document has no messages array');
          const batch = {
            sessionId: String(parsed.sessionId ?? sessionId),
            parkedAtMs: Number(parsed.parkedAtMs),
            reason: String(parsed.reason ?? 'unknown'),
            releaseAtMs: Number(parsed.releaseAtMs),
            messages: parsed.messages.map((message) => ({
              id: String(message.id),
              role: String(message.role ?? 'user'),
              source: String(message.source ?? 'unknown'),
              summary: String(message.summary ?? ''),
            })),
            ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
            ...(parsed.fingerprint !== null && typeof parsed.fingerprint === 'object'
              ? { fingerprint: parsed.fingerprint }
              : {}),
          };
          return { ok: true, batch };
        } catch (error) {
          if (isMissingFile(error)) return { ok: true, batch: undefined };
          const message = error instanceof Error ? error.message : String(error);
          report({ level: 'warn', code: 'ledger-read-failed', message });
          return { ok: false, code: 'ledger-read-failed', message };
        }
      });
    },

    /**
     * Append one re-delivery attempt and its outcome.
     *
     * Called once per release pass, whatever the outcome, so the file answers
     * both "did it deliver?" and "how did it fail?" after the fact. A successful
     * delivery is recorded too: a missing record is then distinguishable from a
     * pass that never ran.
     *
     * @param {object} record - `sessionId`, `outcome` (`delivered`|`failed`), and on failure `stage` and `error`.
     * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>} the outcome.
     */
    async appendDeliveryOutcome(record) {
      return enqueue('__delivery__', async () => {
        const file = join(root, LEDGER_DIR_NAME, DELIVERY_LOG_FILE);
        try {
          await mkdir(dirname(file), { recursive: true });
          await appendFile(file, `${JSON.stringify({ ...record, atMs: Date.now() })}\n`, 'utf8');
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report({ level: 'warn', code: 'delivery-log-failed', message });
          return { ok: false, code: 'delivery-log-failed', message };
        }
      });
    },

    /**
     * Read the re-delivery log.
     *
     * @param {number} [limit] - most recent records to return.
     * @returns {Promise<object[]>} records, oldest first.
     */
    async readDeliveryOutcomes(limit = 20) {
      const file = join(root, LEDGER_DIR_NAME, DELIVERY_LOG_FILE);
      let raw;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return [];
        report({ level: 'warn', code: 'delivery-log-read-failed', message: String(error) });
        return [];
      }
      const records = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          report({ level: 'warn', code: 'delivery-log-line-skipped', message: 'a malformed delivery line was skipped' });
        }
      }
      return records.slice(-limit);
    },

    /**
     * Append one manual-override record to the shared audit trail.
     *
     * Separate from the per-session ledger on purpose: the ledger holds *current*
     * state and is deleted once work is delivered, so an audit written there
     * would be erased by the very delivery it describes. This file is
     * append-only, so "who spent money during peak" stays answerable after the
     * fact and across restarts.
     *
     * @param {object} record - the audit record; `atMs` is added here.
     * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>} the outcome.
     */
    async appendOverrideAudit(record) {
      return enqueue('__audit__', async () => {
        const file = join(root, LEDGER_DIR_NAME, OVERRIDE_AUDIT_FILE);
        try {
          await mkdir(dirname(file), { recursive: true });
          await appendFile(file, `${JSON.stringify({ ...record, atMs: record.atMs ?? Date.now() })}\n`, 'utf8');
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report({ level: 'warn', code: 'override-audit-failed', message });
          return { ok: false, code: 'override-audit-failed', message };
        }
      });
    },

    /**
     * Read the manual-override audit trail.
     *
     * A malformed line is reported and skipped rather than failing the read:
     * losing one record must not hide the others.
     *
     * @param {number} [limit] - most recent records to return.
     * @returns {Promise<object[]>} audit records, oldest first.
     */
    async readOverrideAudit(limit = 20) {
      const file = join(root, LEDGER_DIR_NAME, OVERRIDE_AUDIT_FILE);
      let raw;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return [];
        report({ level: 'warn', code: 'override-audit-read-failed', message: String(error) });
        return [];
      }
      const records = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          report({ level: 'warn', code: 'override-audit-line-skipped', message: 'a malformed audit line was skipped' });
        }
      }
      return records.slice(-limit);
    },

    /**
     * Forget a session's batch after it has been delivered (or intentionally dropped).
     *
     * @param {string} sessionId - session to clear.
     * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>} the outcome.
     */
    async clear(sessionId) {
      return enqueue(sessionId, async () => {
        try {
          const { rm } = await import('node:fs/promises');
          await rm(fileFor(sessionId), { force: true });
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report({ level: 'warn', code: 'ledger-clear-failed', message });
          return { ok: false, code: 'ledger-clear-failed', message };
        }
      });
    },
  };
}

/**
 * Whether a filesystem error means "the ledger file is simply not there yet".
 * @param {unknown} error - the thrown value.
 * @returns {boolean} whether it is a missing-file error.
 */
function isMissingFile(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * Summarize one message for the held-batch receipt.
 *
 * Reads text blocks only; anything else contributes its type name, so a receipt
 * can never accidentally quote content the user did not write.
 *
 * @param {{content?: unknown}} message - a user message.
 * @returns {string} a single-line summary.
 */
export function summarizeMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join(' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (text === '') return '(no text content)';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
