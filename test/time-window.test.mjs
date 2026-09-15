/**
 * Self-check for the peak/off-peak window mathematics.
 *
 * Run with `node test/time-window.test.mjs`. No test runner, no dependencies:
 * the module under test is pure, so the whole suite is assertion arithmetic over
 * a fixed UTC clock. Every expectation is written as an explicit UTC instant so
 * a reader can check it against the official rule without running the code.
 *
 * Official rule under test (https://api-docs.deepseek.com/quick_start/pricing):
 *   peak = UTC 01:00-04:00 and 06:00-10:00, Monday through Friday; all other
 *   hours off-peak; off-peak costs half of peak.
 *
 * @module peak-valley-brake/test/time-window
 */

import assert from 'node:assert/strict';

import {
  OFFICIAL_PEAK_WINDOWS,
  OFFICIAL_TABLE_AS_OF,
  boundariesAround,
  describeInstant,
  dispatchVerdict,
  explainHold,
  isPeakAt,
  nextTransitionAfter,
  phaseAt,
} from '../lib/time-window.js';

/** Counters for the hand-rolled runner. */
const results = { passed: 0, failed: 0 };

/**
 * Run one named assertion block and record its outcome.
 * @param {string} name - the case name.
 * @param {() => void} body - assertions to run.
 * @returns {void}
 */
function test(name, body) {
  try {
    body();
    results.passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    results.failed += 1;
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Build an epoch-ms instant from a UTC calendar description.
 * @param {string} iso - an ISO-8601 UTC timestamp, e.g. `2026-09-15T01:00:00Z`.
 * @returns {number} epoch milliseconds.
 */
function at(iso) {
  const value = Date.parse(iso);
  assert.ok(Number.isFinite(value), `fixture timestamp must parse: ${iso}`);
  return value;
}

/**
 * Assert a phase state and peak/off-peak classification together.
 * @param {string} iso - the instant to classify.
 * @param {string} expectedState - expected `state`.
 * @param {string} expectedPhase - expected `phase`.
 * @param {object} [options] - schedule options; omitted means the defaults.
 * @returns {void}
 */
function expectState(iso, expectedState, expectedPhase, options) {
  const actual = phaseAt(at(iso), options);
  assert.equal(
    actual.state,
    expectedState,
    `${iso} expected state ${expectedState} but got ${actual.state}`,
  );
  assert.equal(actual.phase, expectedPhase, `${iso} expected phase ${expectedPhase} but got ${actual.phase}`);
}

// 2026-09-15 is a Tuesday; 2026-09-14 a Monday; 2026-09-12 a Saturday.
process.stdout.write('peak-valley-brake time-window, official table as of ' + OFFICIAL_TABLE_AS_OF + '\n');

process.stdout.write('\nofficial table shape\n');

test('table declares exactly two weekday peak windows', () => {
  assert.equal(OFFICIAL_PEAK_WINDOWS.length, 2);
  for (const window of OFFICIAL_PEAK_WINDOWS) {
    assert.deepEqual([...window.weekdays], [1, 2, 3, 4, 5], 'peak windows cover UTC Monday-Friday');
    assert.equal(window.endMinute - window.startMinute, window.durationMinutes, 'duration is carried explicitly');
  }
});

test('table rows are the official 01:00-04:00 and 06:00-10:00 UTC windows', () => {
  assert.deepEqual(
    OFFICIAL_PEAK_WINDOWS.map((window) => [window.startMinute, window.endMinute]),
    [
      [60, 240],
      [360, 600],
    ],
  );
});

test('table is deeply frozen so a caller cannot mutate the schedule', () => {
  assert.ok(Object.isFrozen(OFFICIAL_PEAK_WINDOWS));
  assert.ok(Object.isFrozen(OFFICIAL_PEAK_WINDOWS[0]));
  assert.ok(Object.isFrozen(OFFICIAL_PEAK_WINDOWS[0].weekdays));
});

process.stdout.write('\nhalf-open window edges (start inclusive, end exclusive)\n');

test('01:00 UTC Tuesday is peak', () => {
  assert.equal(isPeakAt(at('2026-09-15T01:00:00Z')), true);
});

test('00:59 UTC Tuesday is not peak', () => {
  assert.equal(isPeakAt(at('2026-09-15T00:59:00Z')), false);
});

test('04:00 UTC Tuesday is not peak (end is exclusive)', () => {
  assert.equal(isPeakAt(at('2026-09-15T04:00:00Z')), false);
});

test('03:59 UTC Tuesday is peak', () => {
  assert.equal(isPeakAt(at('2026-09-15T03:59:00Z')), true);
});

test('06:00 UTC Tuesday is peak (second window start is inclusive)', () => {
  assert.equal(isPeakAt(at('2026-09-15T06:00:00Z')), true);
});

test('10:00 UTC Tuesday is not peak (second window end is exclusive)', () => {
  assert.equal(isPeakAt(at('2026-09-15T10:00:00Z')), false);
});

test('09:59 UTC Tuesday is peak', () => {
  assert.equal(isPeakAt(at('2026-09-15T09:59:00Z')), true);
});

process.stdout.write('\nbraces: 5 minutes before, 1 minute after\n');

test('00:55 UTC is armed, one minute earlier is open', () => {
  expectState('2026-09-15T00:55:00Z', 'armed', 'off-peak');
  expectState('2026-09-15T00:54:00Z', 'open', 'off-peak');
});

test('05:55 UTC is armed before the second window, 05:54 is open', () => {
  expectState('2026-09-15T05:55:00Z', 'armed', 'off-peak');
  expectState('2026-09-15T05:54:00Z', 'open', 'off-peak');
});

test('the arm edge reports the coming peak start as its transition', () => {
  const phase = phaseAt(at('2026-09-15T00:56:00Z'));
  assert.equal(phase.state, 'armed');
  assert.equal(phase.transitionMs, at('2026-09-15T01:00:00Z'));
});

test('04:00 UTC is releasing, 04:01 is open', () => {
  expectState('2026-09-15T04:00:00Z', 'releasing', 'off-peak');
  expectState('2026-09-15T04:01:00Z', 'open', 'off-peak');
});

test('10:00 UTC is releasing, 10:01 is open', () => {
  expectState('2026-09-15T10:00:00Z', 'releasing', 'off-peak');
  expectState('2026-09-15T10:01:00Z', 'open', 'off-peak');
});

test('inside a peak window the reported release is the post-brace edge', () => {
  const phase = phaseAt(at('2026-09-15T01:30:00Z'));
  assert.equal(phase.state, 'peak');
  assert.equal(phase.peakStartMs, at('2026-09-15T01:00:00Z'));
  assert.equal(phase.peakEndMs, at('2026-09-15T04:00:00Z'));
  assert.equal(phase.releaseMs, at('2026-09-15T04:01:00Z'));
  assert.equal(phase.transitionMs, at('2026-09-15T04:01:00Z'));
});

process.stdout.write('\nweekend is entirely off-peak\n');

test('Saturday 02:00 UTC is off-peak even though it is a peak minute-of-day', () => {
  assert.equal(isPeakAt(at('2026-09-12T02:00:00Z')), false);
  expectState('2026-09-12T02:00:00Z', 'open', 'off-peak');
});

test('Saturday 07:00 UTC is off-peak', () => {
  expectState('2026-09-12T07:00:00Z', 'open', 'off-peak');
});

test('Sunday 03:00 UTC is off-peak', () => {
  expectState('2026-09-13T03:00:00Z', 'open', 'off-peak');
});

test('every minute of a whole weekend is off-peak', () => {
  const start = at('2026-09-12T00:00:00Z');
  for (let minute = 0; minute < 2 * 24 * 60; minute += 1) {
    const instant = start + minute * 60_000;
    assert.equal(isPeakAt(instant), false, `${new Date(instant).toISOString()} must be off-peak`);
  }
});

process.stdout.write('\nweekend-to-Monday boundary\n');

test('Monday 00:55 UTC is armed after the weekend gap', () => {
  expectState('2026-09-14T00:55:00Z', 'armed', 'off-peak');
});

test('Monday 01:00 UTC is peak', () => {
  expectState('2026-09-14T01:00:00Z', 'peak', 'peak');
});

test('Monday 00:54 UTC is open', () => {
  expectState('2026-09-14T00:54:00Z', 'open', 'off-peak');
});

test('Sunday 23:59 UTC is open, not armed, because the next peak is still far away', () => {
  expectState('2026-09-13T23:59:00Z', 'open', 'off-peak');
});

process.stdout.write('\nFriday close through the weekend stays open\n');

test('Friday 10:00 UTC is releasing and 10:01 open', () => {
  expectState('2026-09-11T10:00:00Z', 'releasing', 'off-peak');
  expectState('2026-09-11T10:01:00Z', 'open', 'off-peak');
});

test('Saturday 00:58 UTC is open: Friday brace never reaches into the weekend', () => {
  expectState('2026-09-12T00:58:00Z', 'open', 'off-peak');
});

process.stdout.write('\nfull-week sweep: four transitions per weekday, none on weekends\n');

test('a Monday-to-Monday minute sweep classifies exactly the official peak minutes', () => {
  const monday = at('2026-09-14T00:00:00Z');
  let peakMinutes = 0;
  let armedMinutes = 0;
  let releasingMinutes = 0;
  for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
    const instant = monday + minute * 60_000;
    const phase = phaseAt(instant);
    if (phase.state === 'peak') peakMinutes += 1;
    if (phase.state === 'armed') armedMinutes += 1;
    if (phase.state === 'releasing') releasingMinutes += 1;
  }
  // 5 weekdays x (180 + 240) peak minutes.
  assert.equal(peakMinutes, 5 * (180 + 240), 'peak minutes in a week');
  // 5 weekdays x 2 windows x 5 brace minutes.
  assert.equal(armedMinutes, 5 * 2 * 5, 'armed minutes in a week');
  // 5 weekdays x 2 windows x 1 release minute. The 04:01 release never
  // collides with the 05:55 arm, and the 10:01 release never collides with
  // Monday 00:55, so no release minute is reclassified as armed.
  assert.equal(releasingMinutes, 5 * 2 * 1, 'releasing minutes in a week');
  assert.equal(
    peakMinutes + armedMinutes + releasingMinutes,
    2100 + 50 + 10,
    'the three holding states account for exactly 2160 of the week\u2019s 10080 minutes',
  );
});

test('a minute is never both armed and releasing', () => {
  const monday = at('2026-09-14T00:00:00Z');
  for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
    const instant = monday + minute * 60_000;
    const phase = phaseAt(instant);
    assert.ok(
      ['peak', 'armed', 'releasing', 'open'].includes(phase.state),
      `unexpected state at ${new Date(instant).toISOString()}`,
    );
  }
});

test('armed state always precedes a peak and releasing always follows one', () => {
  const monday = at('2026-09-14T00:00:00Z');
  for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
    const instant = monday + minute * 60_000;
    const phase = phaseAt(instant);
    if (phase.state === 'armed') {
      assert.ok(phase.peakStartMs > instant, 'armed must look forward to a future peak');
      assert.equal(isPeakAt(phase.peakStartMs), true, 'the promised peak start must really be peak');
    }
    if (phase.state === 'releasing') {
      assert.ok(phase.peakEndMs <= instant, 'releasing must follow a finished peak');
      assert.equal(isPeakAt(phase.peakEndMs - 60_000), true, 'the finished peak must have been peak');
    }
    if (phase.state === 'open' || phase.state === 'peak') {
      assert.equal(phase.transitionMs >= instant, true, 'a transition is never in the past');
    }
  }
});

process.stdout.write('\ndispatch verdict and manual override\n');

test('verdict holds during peak, armed, and releasing; opens otherwise', () => {
  assert.deepEqual(
    [
      dispatchVerdict(at('2026-09-15T02:00:00Z')).hold,
      dispatchVerdict(at('2026-09-15T00:56:00Z')).hold,
      dispatchVerdict(at('2026-09-15T04:00:30Z')).hold,
      dispatchVerdict(at('2026-09-15T11:00:00Z')).hold,
    ],
    [true, true, true, false],
  );
});

test('verdict names the reason it holds', () => {
  assert.equal(dispatchVerdict(at('2026-09-15T02:00:00Z')).reason, 'peak');
  assert.equal(dispatchVerdict(at('2026-09-15T00:56:00Z')).reason, 'pre-peak-brace');
  assert.equal(dispatchVerdict(at('2026-09-15T04:00:30Z')).reason, 'post-peak-brace');
  assert.equal(dispatchVerdict(at('2026-09-15T11:00:00Z')).reason, 'off-peak');
});

test('a manual override releases inside a peak window and says so', () => {
  const verdict = dispatchVerdict(at('2026-09-15T02:00:00Z'), { override: true });
  assert.equal(verdict.hold, false);
  assert.equal(verdict.reason, 'manual-override');
  assert.equal(verdict.phase.state, 'peak', 'the override does not rewrite the schedule');
});

process.stdout.write('\nconfigurable braces\n');

test('a zero brace turns the arm edge into the window start itself', () => {
  const options = { brakeLeadMinutes: 0, releaseDelayMinutes: 0 };
  expectState('2026-09-15T00:58:00Z', 'open', 'off-peak', options);
  expectState('2026-09-15T00:59:00Z', 'open', 'off-peak', options);
  assert.equal(phaseAt(at('2026-09-15T01:00:00Z'), options).state, 'peak');
  assert.equal(phaseAt(at('2026-09-15T04:00:00Z'), options).state, 'open');
});

test('a larger lead widens the armed region by exactly that many minutes', () => {
  const options = { brakeLeadMinutes: 30 };
  expectState('2026-09-15T00:30:00Z', 'armed', 'off-peak', options);
  expectState('2026-09-15T00:35:00Z', 'armed', 'off-peak', options);
  expectState('2026-09-15T00:29:00Z', 'open', 'off-peak', options);
});

test('an empty table is always open and never transitions', () => {
  const phase = phaseAt(at('2026-09-15T02:00:00Z'), { windows: [] });
  assert.equal(phase.state, 'open');
  assert.equal(phase.transitionMs, Number.POSITIVE_INFINITY);
  assert.equal(isPeakAt(at('2026-09-15T02:00:00Z'), []), false);
});

test('a custom table is honoured instead of the official one', () => {
  const custom = [{ weekdays: [1, 2, 3, 4, 5], startMinute: 0, endMinute: 60, durationMinutes: 60 }];
  assert.equal(isPeakAt(at('2026-09-15T00:30:00Z'), custom), true);
  assert.equal(isPeakAt(at('2026-09-15T01:30:00Z'), custom), false);
});

test('invalid brace options are rejected loudly rather than silently coerced', () => {
  assert.throws(() => phaseAt(at('2026-09-15T02:00:00Z'), { brakeLeadMinutes: -1 }), TypeError);
  assert.throws(() => phaseAt(at('2026-09-15T02:00:00Z'), { brakeLeadMinutes: 1.5 }), TypeError);
  assert.throws(() => phaseAt(at('2026-09-15T02:00:00Z'), { releaseDelayMinutes: Number.NaN }), TypeError);
});

process.stdout.write('\ntransition boundaries\n');

test('boundariesAround lists the four edges of a weekday peak in order', () => {
  // Probe Tuesday 00:00, one hour before the first peak of the day.
  const instants = boundariesAround(at('2026-09-15T00:00:00Z'))
    .filter((boundary) => boundary.instantMs >= at('2026-09-15T00:00:00Z') && boundary.instantMs <= at('2026-09-15T10:01:00Z'))
    .map((boundary) => [boundary.edge, describeInstant(boundary.instantMs).utc]);
  assert.deepEqual(instants, [
    ['arm', '2026-09-15 00:55 UTC'],
    ['peak-start', '2026-09-15 01:00 UTC'],
    ['peak-end', '2026-09-15 04:00 UTC'],
    ['release', '2026-09-15 04:01 UTC'],
    ['arm', '2026-09-15 05:55 UTC'],
    ['peak-start', '2026-09-15 06:00 UTC'],
    ['peak-end', '2026-09-15 10:00 UTC'],
    ['release', '2026-09-15 10:01 UTC'],
  ]);
});

test('boundariesAround stays in ascending order and never repeats an instant', () => {
  const boundaries = boundariesAround(at('2026-09-15T00:00:00Z'));
  for (let index = 1; index < boundaries.length; index += 1) {
    assert.ok(
      boundaries[index].instantMs > boundaries[index - 1].instantMs,
      `boundary ${index} is not strictly after its predecessor`,
    );
  }
});

test('holdsAfter is true at arm and peak edges and false at release', () => {
  const byEdge = new Map(boundariesAround(at('2026-09-15T00:00:00Z')).map((boundary) => [boundary.edge, boundary.holdsAfter]));
  assert.equal(byEdge.get('arm'), true);
  assert.equal(byEdge.get('peak-start'), true);
  assert.equal(byEdge.get('peak-end'), true);
  assert.equal(byEdge.get('release'), false);
});

test('holdsAfter matches the verdict on the far side of every boundary', () => {
  const boundaries = boundariesAround(at('2026-09-14T00:00:00Z'));
  for (const boundary of boundaries) {
    const after = dispatchVerdict(boundary.instantMs).hold;
    assert.equal(
      after,
      boundary.holdsAfter,
      `${boundary.edge} at ${describeInstant(boundary.instantMs).utc} promises holdsAfter=${boundary.holdsAfter}`,
    );
  }
});

test('only the arm edge engages the brake and only the release edge lifts it', () => {
  const boundaries = boundariesAround(at('2026-09-14T00:00:00Z'));
  for (const boundary of boundaries) {
    const before = dispatchVerdict(boundary.instantMs - 1).hold;
    const after = dispatchVerdict(boundary.instantMs).hold;
    if (boundary.edge === 'arm') {
      assert.equal(before, false, `open just before the arm at ${describeInstant(boundary.instantMs).utc}`);
      assert.equal(after, true, `held at the arm at ${describeInstant(boundary.instantMs).utc}`);
    }
    if (boundary.edge === 'release') {
      assert.equal(before, true, `held just before the release at ${describeInstant(boundary.instantMs).utc}`);
      assert.equal(after, false, `open at the release at ${describeInstant(boundary.instantMs).utc}`);
    }
    if (boundary.edge === 'peak-start' || boundary.edge === 'peak-end') {
      assert.equal(before, true, `${boundary.edge} happens inside an already-held stretch`);
      assert.equal(after, true, `${boundary.edge} leaves the stretch held`);
    }
  }
});

test('nextTransitionAfter names the coming edge for each phase', () => {
  assert.deepEqual(
    [
      nextTransitionAfter(at('2026-09-15T00:00:00Z')).edge,
      nextTransitionAfter(at('2026-09-15T00:56:00Z')).edge,
      nextTransitionAfter(at('2026-09-15T02:00:00Z')).edge,
      nextTransitionAfter(at('2026-09-15T04:00:30Z')).edge,
    ],
    ['arm', 'peak-start', 'peak-end', 'release'],
  );
});

test('nextTransitionAfter is always strictly in the future', () => {
  const monday = at('2026-09-14T00:00:00Z');
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const instant = monday + minute * 60_000;
    const upcoming = nextTransitionAfter(instant);
    assert.ok(upcoming !== undefined, `a transition must exist at ${new Date(instant).toISOString()}`);
    assert.ok(
      upcoming.instantMs > instant,
      `next transition at ${new Date(instant).toISOString()} must be in the future`,
    );
  }
});

test('an empty table has no transitions', () => {
  assert.equal(nextTransitionAfter(at('2026-09-15T02:00:00Z'), { windows: [] }), undefined);
  assert.deepEqual(boundariesAround(at('2026-09-15T02:00:00Z'), { windows: [] }), []);
});

test('explainHold names the reason and the coming edge in both clocks', () => {
  const held = explainHold(at('2026-09-15T02:00:00Z'));
  assert.match(held, /held \(peak\)/u);
  assert.match(held, /2026-09-15 02:00 UTC/u);
  assert.match(held, /peak-end at 2026-09-15 04:00 UTC/u);
  const open = explainHold(at('2026-09-15T11:00:00Z'));
  assert.match(open, /open at 2026-09-15 11:00 UTC/u);
});

process.stdout.write('\nhuman-facing rendering\n');

test('describeInstant renders the same instant in UTC and the local offset', () => {
  const rendered = describeInstant(at('2026-09-15T01:00:00Z'));
  assert.equal(rendered.utc, '2026-09-15 01:00 UTC');
  assert.match(rendered.local, /^2026-09-15 \d{2}:00 UTC[+-]\d{2}:\d{2}$/u);
});

test('describeInstant renders non-finite edges as never', () => {
  assert.deepEqual(describeInstant(Number.POSITIVE_INFINITY), { utc: 'never', local: 'never' });
});

process.stdout.write(`\n${results.passed} passed, ${results.failed} failed\n`);
if (results.failed > 0) process.exitCode = 1;
