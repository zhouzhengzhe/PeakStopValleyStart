/**
 * Workspace drift detection.
 *
 * Purpose: the brake can hold work for hours. During that time a human may edit
 * files, switch branches, or run a formatter — and the agent's picture of the
 * workspace, frozen in its session history, silently becomes wrong. On release
 * the agent would resume against a world that no longer matches what it last
 * read, which is exactly the class of failure the objective calls "出错".
 *
 * So the brake records a workspace fingerprint when it stops, re-measures on
 * release, and tells the agent what changed. The result is advisory by design:
 * drift is reported, never used to block the release. A guard whose job is to
 * keep work moving must not become the reason work stalls.
 *
 * Fingerprint composition, cheapest and most reliable first:
 *   1. `HEAD` commit — catches a branch switch or a commit made while held.
 *   2. `git status --porcelain --untracked-files=all` — catches an edited,
 *      added, deleted, or newly created file, and any staging change. This is
 *      the signal that actually matters: it sees the human's edits even to
 *      files the agent never touched.
 *
 * Deliberately *not* part of the fingerprint: `.git/index`'s mtime. Running
 * `git status` refreshes that file's stat information as a side effect, so two
 * measurements of an untouched repository disagree on it — a false positive that
 * would make the guard cry drift on every single release. The status digest
 * already reflects everything the index affects, so nothing is lost.
 *
 * A directory that is not a git repository yields a fingerprint marked
 * `unverified` rather than a failure. Reporting "I could not check" is honest;
 * pretending a non-repository has not drifted is not. The note it carries is a
 * machine-readable code, never prose, so the caller renders the explanation in
 * the operator's language instead of leaking an English diagnostic into a
 * Chinese sentence.
 *
 * Privacy: only *relative* paths are ever recorded, and the status text itself
 * is reduced to a digest plus a bounded path list. Absolute paths and file
 * contents never enter the ledger.
 *
 * @module peak-valley-brake/workspace-drift
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { dictionaryFor, render } from './messages.js';

const run = promisify(execFile);

/** Cap on remembered changed paths, so a huge diff cannot bloat the ledger. */
const MAX_RECORDED_PATHS = 50;
/** Upper bound on one git invocation, so a hung git cannot stall a release. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} WorkspaceFingerprint
 * @property {'git'|'unverified'} kind - how the workspace was measured.
 * @property {number} measuredAtMs - when the measurement was taken.
 * @property {string|undefined} head - `HEAD` commit, when the workspace is a repository.
 * @property {string|undefined} statusDigest - digest of the porcelain status text.
 * @property {'no-working-directory'|'not-a-repository'|undefined} note - machine-readable
 *   reason the workspace could not be measured, for the caller to translate.
 */

/**
 * Run one git command, returning `undefined` instead of throwing.
 * @param {string[]} args - git arguments.
 * @param {string} cwd - directory to run in.
 * @returns {Promise<{stdout: string} | undefined>} the result, or `undefined` on any failure.
 */
async function git(args, cwd) {
  try {
    const result = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return { stdout: String(result.stdout ?? '') };
  } catch {
    // Not a repository, no git on PATH, a locked index, a timeout — all of them
    // mean "cannot measure this way", and the caller decides what that implies.
    return undefined;
  }
}

/**
 * Parse `git status --porcelain=v1` output into repo-relative paths.
 *
 * Handles renames (`R  old -> new`), quoted paths (git quotes non-ASCII names),
 * and untracked entries. Only the path portion is kept.
 *
 * @param {string} porcelain - raw porcelain output.
 * @returns {string[]} changed paths, sorted and de-duplicated.
 */
export function parsePorcelainPaths(porcelain) {
  const paths = new Set();
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.replace(/\r$/u, '');
    if (line.trim() === '') continue;
    // Skip the two status columns and the separating space.
    let rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    let path = rest.trim();
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) path = path.slice(1, -1);
    if (path !== '') paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Measure a workspace.
 *
 * Never throws: every failure becomes an `unverified` fingerprint carrying a
 * note, because a release must not be blocked by a diagnostic.
 *
 * @param {string} cwd - absolute workspace directory.
 * @param {object} [options] - measurement options.
 * @param {number} [options.nowMs] - clock override, for deterministic tests.
 * @returns {Promise<WorkspaceFingerprint>} the measurement.
 */
export async function captureFingerprint(cwd, options = {}) {
  const measuredAtMs = options.nowMs ?? Date.now();
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { kind: 'unverified', measuredAtMs, note: 'no-working-directory' };
  }

  const head = await git(['rev-parse', 'HEAD'], cwd);
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  if (head === undefined && status === undefined) {
    return { kind: 'unverified', measuredAtMs, note: 'not-a-repository' };
  }

  const statusText = status?.stdout ?? '';

  return {
    kind: 'git',
    measuredAtMs,
    head: head?.stdout.trim() ?? '',
    statusDigest: createHash('sha256').update(statusText).digest('hex'),
  };
}

/**
 * Compare two fingerprints and describe what changed.
 *
 * The reasons are returned as structured codes rather than finished sentences,
 * so the caller can render them in the operator's language without this module
 * needing to know which language that is.
 *
 * @param {WorkspaceFingerprint|undefined} before - the fingerprint recorded at hold time.
 * @param {WorkspaceFingerprint} after - the fingerprint measured at release time.
 * @returns {{status: 'unchanged'|'drifted'|'unverified', reasons: {code: string, [key: string]: unknown}[], before: WorkspaceFingerprint|undefined, after: WorkspaceFingerprint}} the comparison.
 */
export function compareFingerprints(before, after) {
  if (before === undefined || before.kind !== 'git' || after.kind !== 'git') {
    const code = before === undefined ? 'no-fingerprint' : 'unmeasurable';
    const note = after.kind === 'unverified' ? after.note : before?.note;
    return {
      status: 'unverified',
      reasons: [{ code, ...(note === undefined ? {} : { note }) }],
      before,
      after,
    };
  }

  const reasons = [];
  if (before.head !== after.head) {
    reasons.push({ code: 'commit-changed', before: short(before.head), after: short(after.head) });
  }
  if (before.statusDigest !== after.statusDigest) {
    reasons.push({ code: 'status-changed' });
  }

  return {
    status: reasons.length === 0 ? 'unchanged' : 'drifted',
    reasons,
    before,
    after,
  };
}

/**
 * Measure the changed paths between two fingerprints.
 *
 * Separated from {@link compareFingerprints} because it costs another git call:
 * the comparison is cheap enough to always run, while naming the files is only
 * worth doing once drift is known to exist.
 *
 * @param {string} cwd - absolute workspace directory.
 * @param {WorkspaceFingerprint|undefined} before - fingerprint recorded at hold time.
 * @param {WorkspaceFingerprint} after - fingerprint measured at release time.
 * @returns {Promise<string[]>} repo-relative changed paths, bounded and sorted.
 */
export async function changedPaths(cwd, before, after) {
  if (before === undefined || before.kind !== 'git' || after.kind !== 'git') return [];
  if (before.statusDigest === after.statusDigest) return [];
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  if (status === undefined) return [];
  return parsePorcelainPaths(status.stdout).slice(0, MAX_RECORDED_PATHS);
}

/**
 * Render a drift report for the model, as plain text.
 *
 * Phrasing matters: this text is injected into a live conversation, so it says
 * what was observed and what to do about it, and it does not pretend to be an
 * instruction from the operator. The caller supplies the dictionary, so the
 * report reaches the model in the same language as the rest of the transcript.
 *
 * @param {{status: string, reasons: {code: string, [key: string]: unknown}[], paths?: string[]}} comparison - the comparison result.
 * @param {{strings: object, fill: Function}} [text] - the resolved text table; English when omitted.
 * @returns {string|undefined} the report, or `undefined` when there is nothing worth saying.
 */
export function renderDriftReport(comparison, text) {
  const table = text ?? dictionaryFor('en');
  const renderReason = (reason) => {
    switch (reason.code) {
      case 'commit-changed':
        return render(table, 'drift.reasonCommit', { before: reason.before, after: reason.after });
      case 'status-changed':
        return render(table, 'drift.reasonStatus');
      case 'no-fingerprint':
        return render(table, 'drift.noFingerprint');
      case 'unmeasurable':
        return reason.note === 'no-working-directory'
          ? render(table, 'drift.noWorkingDirectory')
          : render(table, 'drift.notARepository');
      default:
        return render(table, 'drift.unmeasurable');
    }
  };
  const reasons = comparison.reasons.map(renderReason);

  if (comparison.status === 'unchanged') return undefined;
  if (comparison.status === 'unverified') {
    return render(table, 'drift.unverified', { reasons: reasons.join('; ') });
  }

  const paths = comparison.paths ?? [];
  const prefix = render(table, 'drift.reasonPrefix');
  const listing =
    paths.length === 0
      ? render(table, 'drift.pathsMissing')
      : `${render(table, 'drift.pathsHeading')}\n${paths.map((path) => `${prefix}${path}`).join('\n')}`;
  const detail = reasons.map((reason) => `${prefix}${reason}`).join('\n');
  return `${render(table, 'drift.intro')}\n${detail}\n${listing}`;
}

/**
 * Shorten a commit id for human-facing text.
 * @param {string|undefined} commit - full commit id.
 * @returns {string} an abbreviated form.
 */
function short(commit) {
  return typeof commit === 'string' && commit.length > 8 ? commit.slice(0, 8) : String(commit ?? 'unknown');
}
