/**
 * Disposable probe: what does the tier countdown actually return?
 *
 * Used while diagnosing two failing expectations in `test/info-bar-view.test.mjs`.
 * Not part of the suite. Delete once the question is answered.
 *
 * @module peak-valley-brake/debug/probe-tier-change
 */

import { nextTierChangeAt, formatCountdown } from '../../../lib/info-bar-view.js';

const at = (iso) => Date.parse(iso);

const cases = [
  ['2026-09-16T00:30:00Z', 'Wed off-peak in the gap'],
  ['2026-09-16T00:56:00Z', 'Wed, inside the pre-peak brace'],
  ['2026-09-16T02:00:00Z', 'Wed peak, first window'],
  ['2026-09-16T03:30:00Z', 'Wed peak, late in the first window'],
  ['2026-09-16T05:00:00Z', 'Wed off-peak, midday gap'],
  ['2026-09-18T11:00:00Z', 'Fri off-peak, after the last window'],
  ['2026-09-19T02:00:00Z', 'Sat, inside a weekday peak hour'],
];

for (const [iso, label] of cases) {
  const from = at(iso);
  const next = nextTierChangeAt(from);
  process.stdout.write(
    `${label.padEnd(38)} ${iso} -> ${new Date(next).toISOString()}  (${formatCountdown(next - from)})\n`,
  );
}
