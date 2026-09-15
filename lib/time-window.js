/**
 * Peak/off-peak window mathematics for the DeepSeek API rate schedule.
 *
 * Official basis (https://api-docs.deepseek.com/quick_start/pricing, footnote 3):
 *   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
 *    (all other hours are off-peak)."
 * Off-peak rates are half of the peak rates.
 *
 * Everything here is a pure function of an epoch-millisecond instant and an
 * immutable window table. No ambient time zone, no current time, no I/O — so a
 * caller can replay any historical instant and get the same answer, which is
 * what makes the cost guard auditable. There is deliberately no dependency on
 * `Date`'s local-time accessors: only `getUTCHours`/`getUTCMinutes`/`getUTCDay`.
 *
 * @module peak-valley-brake/time-window
 */

/** Minutes per hour, used to express window edges in minute-of-week arithmetic. */
const MINUTES_PER_HOUR = 60;
/** Minutes per day. */
const MINUTES_PER_DAY = 24 * 60;
/** Milliseconds per minute. */
const MS_PER_MINUTE = 60_000;
/** Milliseconds per day. */
const MS_PER_DAY = 86_400_000;
/** The epoch (1970-01-01) was a Thursday; UTC weekday indices are Sunday-based. */
const EPOCH_WEEKDAY = 4;

/**
 * A peak window expressed as UTC minute-of-day bounds on selected UTC weekdays.
 * `startMinute` is inclusive, `endMinute` is exclusive, so a window ending at
 * 04:00 does not include 04:00 itself.
 *
 * @typedef {object} PeakWindow
 * @property {number[]} weekdays - UTC weekdays covered (0=Sunday … 6=Saturday).
 * @property {number} startMinute - inclusive minute-of-day (0..1439).
 * @property {number} endMinute - exclusive minute-of-day (1..1440).
 * @property {number} durationMinutes - `endMinute - startMinute`, carried explicitly so downstream arithmetic never has to invert the table.
 */

/**
 * Build one frozen window, deriving its duration from its own bounds.
 * @param {number[]} weekdays - UTC weekdays covered.
 * @param {number} startMinute - inclusive minute-of-day.
 * @param {number} durationMinutes - window length in minutes.
 * @returns {Readonly<PeakWindow>} the frozen window.
 */
function peakWindow(weekdays, startMinute, durationMinutes) {
  return Object.freeze({
    weekdays: Object.freeze([...weekdays]),
    startMinute,
    endMinute: startMinute + durationMinutes,
    durationMinutes,
  });
}

/**
 * The current official window table: two peak windows on each UTC weekday.
 * Weekend instants are off-peak because no window lists weekday 0 or 6.
 *
 * @type {readonly PeakWindow[]}
 */
export const OFFICIAL_PEAK_WINDOWS = Object.freeze([
  peakWindow([1, 2, 3, 4, 5], 60, 180),
  peakWindow([1, 2, 3, 4, 5], 360, 240),
]);

/** Calendar date through which {@link OFFICIAL_PEAK_WINDOWS} was checked against the official page. */
export const OFFICIAL_TABLE_AS_OF = '2026-09-15';

/**
 * Convert an epoch-millisecond instant to the UTC weekday it falls on.
 * @param {number} epochMs - the instant.
 * @returns {number} UTC weekday, 0=Sunday … 6=Saturday.
 */
function utcWeekday(epochMs) {
  const days = Math.floor(epochMs / MS_PER_DAY);
  return (EPOCH_WEEKDAY + days) % 7;
}

/**
 * Convert an epoch-millisecond instant to its UTC minute-of-day.
 * @param {number} epochMs - the instant.
 * @returns {number} minute-of-day, 0..1439.
 */
function utcMinuteOfDay(epochMs) {
  const date = new Date(epochMs);
  return date.getUTCHours() * MINUTES_PER_HOUR + date.getUTCMinutes();
}

/**
 * Find the start of the peak window that begins at or after an instant.
 *
 * Mirrors `ringAtOrAfter` for window starts: the answer is never behind `fromMs`,
 * so a caller passing "now" always receives a future edge.
 *
 * @param {number} fromMs - instant to search forward from.
 * @param {readonly PeakWindow[]} windows - window table to search.
 * @returns {number} epoch ms of the next window start, or `Infinity` when the table is empty.
 */
function nextWindowStart(fromMs, windows) {
  if (windows.length === 0) return Number.POSITIVE_INFINITY;
  const startDay = Math.floor(fromMs / MS_PER_DAY);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const dayStart = (startDay + dayOffset) * MS_PER_DAY;
    const weekday = utcWeekday(dayStart);
    for (const window of windows) {
      if (!window.weekdays.includes(weekday)) continue;
      const candidate = dayStart + window.startMinute * MS_PER_MINUTE;
      if (candidate >= fromMs) return candidate;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Determine whether an instant sits inside a peak window.
 *
 * The interval is half-open: `[start, end)`. A window's own start minute is
 * peak; its end minute is off-peak.
 *
 * @param {number} epochMs - the instant to classify.
 * @param {readonly PeakWindow[]} windows - window table to test.
 * @returns {boolean} whether the instant is peak.
 */
export function isPeakAt(epochMs, windows = OFFICIAL_PEAK_WINDOWS) {
  const weekday = utcWeekday(epochMs);
  const minute = utcMinuteOfDay(epochMs);
  return windows.some(
    (window) => window.weekdays.includes(weekday) && minute >= window.startMinute && minute < window.endMinute,
  );
}

/**
 * Split one peak window into the four edges the brake reasons about.
 *
 * The brake must not release inside the brace before a peak ("arm") nor inside
 * the brace after it ("release"), otherwise a short adjacent window would arm
 * and release on the same instant and the guard would flicker.
 *
 * @param {number} peakStartMs - window start instant.
 * @param {number} durationMinutes - that window's scheduled length.
 * @param {number} brakeLeadMinutes - minutes before the window to stop dispatching.
 * @param {number} releaseDelayMinutes - minutes after the window before dispatching resumes.
 * @returns {{armMs: number, peakStartMs: number, peakEndMs: number, releaseMs: number}} the edges.
 */
function windowEdges(peakStartMs, durationMinutes, brakeLeadMinutes, releaseDelayMinutes) {
  const peakEndMs = peakStartMs + durationMinutes * MS_PER_MINUTE;
  return {
    armMs: peakStartMs - brakeLeadMinutes * MS_PER_MINUTE,
    peakStartMs,
    peakEndMs,
    releaseMs: peakEndMs + releaseDelayMinutes * MS_PER_MINUTE,
  };
}

/**
 * Read the scheduled duration of the window starting at an instant.
 *
 * The window start is always a UTC minute boundary, so its minute-of-day plus
 * the start minute identify the owning row exactly.
 *
 * @param {number} peakStartMs - window start instant, which must be a real window start.
 * @param {readonly PeakWindow[]} windows - window table that produced the start.
 * @returns {number} duration in minutes.
 */
function durationMinutesOfStart(peakStartMs, windows) {
  const minute = utcMinuteOfDay(peakStartMs);
  const owner = windows.find((window) => window.startMinute === minute);
  if (owner === undefined) {
    throw new Error(`peak-valley-brake: ${new Date(peakStartMs).toISOString()} is not a peak window start`);
  }
  return owner.durationMinutes;
}

/**
 * Find the start of the latest peak window at or before an instant.
 * @param {number} fromMs - instant to search backward from.
 * @param {readonly PeakWindow[]} windows - window table to search.
 * @returns {number} epoch ms of that window start, or `-Infinity` for an empty table.
 */
function previousWindowStart(fromMs, windows = OFFICIAL_PEAK_WINDOWS) {
  if (windows.length === 0) return Number.NEGATIVE_INFINITY;
  const startDay = Math.floor(fromMs / MS_PER_DAY);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const dayStart = (startDay - dayOffset) * MS_PER_DAY;
    const weekday = utcWeekday(dayStart);
    let best = Number.NEGATIVE_INFINITY;
    for (const window of windows) {
      if (!window.weekdays.includes(weekday)) continue;
      const candidate = dayStart + window.startMinute * MS_PER_MINUTE;
      if (candidate <= fromMs && candidate > best) best = candidate;
    }
    if (best !== Number.NEGATIVE_INFINITY) return best;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * Classify one instant into the brake's four observable states.
 *
 * - `peak`     — inside a peak window: no dispatch, no exceptions.
 * - `armed`    — inside the pre-peak brace: stop dispatching before the price changes.
 * - `releasing`— inside the post-peak brace: hold until requests can no longer be billed at peak.
 * - `open`     — clear to dispatch.
 *
 * `armed` wins over `releasing` when the two braces would overlap, because
 * refusing to dispatch is always the safe side of an ambiguity.
 *
 * @param {number} epochMs - instant to classify.
 * @param {object} [options] - schedule options.
 * @param {number} [options.brakeLeadMinutes] - minutes of pre-peak brace.
 * @param {number} [options.releaseDelayMinutes] - minutes of post-peak brace.
 * @param {readonly PeakWindow[]} [options.windows] - window table override.
 * @returns {{state: 'peak'|'armed'|'releasing'|'open', phase: 'peak'|'off-peak', peakStartMs: number, peakEndMs: number, releaseMs: number, armMs: number, transitionMs: number}} the classification.
 */
export function phaseAt(epochMs, options = {}) {
  const windows = options.windows ?? OFFICIAL_PEAK_WINDOWS;
  const brakeLeadMinutes = options.brakeLeadMinutes ?? 5;
  const releaseDelayMinutes = options.releaseDelayMinutes ?? 1;
  assertNonNegativeMinutes(brakeLeadMinutes, 'brakeLeadMinutes');
  assertNonNegativeMinutes(releaseDelayMinutes, 'releaseDelayMinutes');

  if (isPeakAt(epochMs, windows)) {
    const peakStartMs = previousWindowStart(epochMs, windows);
    const edge = windowEdges(
      peakStartMs,
      durationMinutesOfStart(peakStartMs, windows),
      brakeLeadMinutes,
      releaseDelayMinutes,
    );
    return {
      state: 'peak',
      phase: 'peak',
      armMs: edge.armMs,
      peakStartMs: edge.peakStartMs,
      peakEndMs: edge.peakEndMs,
      releaseMs: edge.releaseMs,
      transitionMs: edge.releaseMs,
    };
  }

  const nextStart = nextWindowStart(epochMs, windows);
  if (Number.isFinite(nextStart)) {
    const edge = windowEdges(
      nextStart,
      durationMinutesOfStart(nextStart, windows),
      brakeLeadMinutes,
      releaseDelayMinutes,
    );
    if (epochMs >= edge.armMs) {
      return {
        state: 'armed',
        phase: 'off-peak',
        armMs: edge.armMs,
        peakStartMs: edge.peakStartMs,
        peakEndMs: edge.peakEndMs,
        releaseMs: edge.releaseMs,
        transitionMs: edge.peakStartMs,
      };
    }
  }

  const previousStart = previousWindowStart(epochMs, windows);
  if (Number.isFinite(previousStart)) {
    const edge = windowEdges(
      previousStart,
      durationMinutesOfStart(previousStart, windows),
      brakeLeadMinutes,
      releaseDelayMinutes,
    );
    if (epochMs < edge.releaseMs) {
      return {
        state: 'releasing',
        phase: 'off-peak',
        armMs: edge.armMs,
        peakStartMs: edge.peakStartMs,
        peakEndMs: edge.peakEndMs,
        releaseMs: edge.releaseMs,
        transitionMs: edge.releaseMs,
      };
    }
  }

  const following = Number.isFinite(nextStart)
    ? windowEdges(nextStart, durationMinutesOfStart(nextStart, windows), brakeLeadMinutes, releaseDelayMinutes)
    : undefined;
  return {
    state: 'open',
    phase: 'off-peak',
    armMs: following?.armMs ?? Number.POSITIVE_INFINITY,
    peakStartMs: following?.peakStartMs ?? Number.POSITIVE_INFINITY,
    peakEndMs: following?.peakEndMs ?? Number.POSITIVE_INFINITY,
    releaseMs: following?.releaseMs ?? Number.POSITIVE_INFINITY,
    transitionMs: following?.armMs ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * Decide whether dispatch must be held at one instant, with the optional
 * one-turn manual override applied.
 *
 * @param {number} epochMs - instant to judge.
 * @param {object} [options] - schedule options plus `override`.
 * @param {boolean} [options.override] - a manual override covering this turn.
 * @returns {{hold: boolean, reason: string, phase: ReturnType<typeof phaseAt>}} the verdict.
 */
export function dispatchVerdict(epochMs, options = {}) {
  const phase = phaseAt(epochMs, options);
  if (options.override === true) return { hold: false, reason: 'manual-override', phase };
  if (phase.state === 'peak') return { hold: true, reason: 'peak', phase };
  if (phase.state === 'armed') return { hold: true, reason: 'pre-peak-brace', phase };
  if (phase.state === 'releasing') return { hold: true, reason: 'post-peak-brace', phase };
  return { hold: false, reason: 'off-peak', phase };
}

/**
 * Enumerate the transition instants that bracket an instant, in order.
 *
 * A caller that only wants "when does the current answer change?" needs the
 * first entry strictly after the instant; a caller rendering a schedule wants
 * the whole neighbourhood. Both come from the same arithmetic, so the list is
 * authoritative rather than reconstructed per consumer.
 *
 * Each entry names the edge and whether the brake is holding on both sides of
 * it (`releases` means a hold ends there; `engages` means one begins). Windows
 * are bounded to a small neighbourhood, so the list never walks the calendar.
 *
 * @param {number} epochMs - instant whose neighbourhood is wanted.
 * @param {object} [options] - schedule options.
 * @returns {{instantMs: number, edge: 'arm'|'peak-start'|'peak-end'|'release', holdsAfter: boolean}[]} ordered boundaries within roughly one window either side.
 */
export function boundariesAround(epochMs, options = {}) {
  const windows = options.windows ?? OFFICIAL_PEAK_WINDOWS;
  const brakeLeadMinutes = options.brakeLeadMinutes ?? 5;
  const releaseDelayMinutes = options.releaseDelayMinutes ?? 1;
  /** Edges of the peak window that starts at one instant. */
  const edgesOf = (startMs) =>
    windowEdges(startMs, durationMinutesOfStart(startMs, windows), brakeLeadMinutes, releaseDelayMinutes);

  const firstDay = Math.floor(epochMs / MS_PER_DAY) - 1;
  const boundaries = [];
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const dayStart = (firstDay + dayOffset) * MS_PER_DAY;
    const weekday = utcWeekday(dayStart);
    for (const window of windows) {
      if (!window.weekdays.includes(weekday)) continue;
      const edge = windowEdges(
        dayStart + window.startMinute * MS_PER_MINUTE,
        window.durationMinutes,
        brakeLeadMinutes,
        releaseDelayMinutes,
      );
      boundaries.push(
        { instantMs: edge.armMs, edge: 'arm', holdsAfter: true },
        { instantMs: edge.peakStartMs, edge: 'peak-start', holdsAfter: true },
        { instantMs: edge.peakEndMs, edge: 'peak-end', holdsAfter: true },
        { instantMs: edge.releaseMs, edge: 'release', holdsAfter: false },
      );
    }
  }
  boundaries.sort((left, right) => left.instantMs - right.instantMs);
  return boundaries;
}

/**
 * Report the instant at which the current dispatch verdict changes.
 *
 * This is the value a countdown needs, and it is derived from the same table
 * as {@link dispatchVerdict}, so a displayed countdown can never disagree with
 * the guard that actually holds the request.
 *
 * @param {number} epochMs - instant to inspect.
 * @param {object} [options] - schedule options.
 * @returns {{transitionMs: number, edge: string, holdsAfter: boolean}|undefined} the next change, or `undefined` when the table never changes again.
 */
export function nextTransitionAfter(epochMs, options = {}) {
  for (const boundary of boundariesAround(epochMs, options)) {
    if (boundary.instantMs > epochMs) return boundary;
  }
  return undefined;
}

/**
 * Explain, in one sentence, what the brake is doing at an instant.
 *
 * @param {number} epochMs - instant to describe.
 * @param {object} [options] - schedule options.
 * @returns {string} a human-facing explanation naming both clocks.
 */
export function explainHold(epochMs, options = {}) {
  const verdict = dispatchVerdict(epochMs, options);
  const phase = describeInstant(epochMs);
  const upcoming = nextTransitionAfter(epochMs, options);
  const next = upcoming === undefined ? 'no further schedule change' : `${upcoming.edge} at ${describeInstant(upcoming.instantMs).utc}`;
  if (!verdict.hold) return `dispatching is open at ${phase.utc} (next: ${next})`;
  return `dispatching is held (${verdict.reason}) at ${phase.utc} (next: ${next})`;
}

/**
 * Render one instant for human-facing text in both the authority time zone and
 * the operator's local zone, so a schedule claim can be checked by eye.
 *
 * @param {number} epochMs - instant to render.
 * @returns {{utc: string, local: string}} both renderings.
 */
export function describeInstant(epochMs) {
  if (!Number.isFinite(epochMs)) return { utc: 'never', local: 'never' };
  const date = new Date(epochMs);
  const pad = (value) => String(value).padStart(2, '0');
  const utc = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return { utc, local };
}

/**
 * Guard a schedule option that must be a non-negative whole number of minutes.
 * @param {number} value - candidate value.
 * @param {string} label - option name for the error message.
 * @returns {void}
 */
function assertNonNegativeMinutes(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`peak-valley-brake: ${label} must be a non-negative integer number of minutes, received ${String(value)}`);
  }
}
