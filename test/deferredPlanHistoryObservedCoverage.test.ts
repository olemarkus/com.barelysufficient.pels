// Unit tests for `formatPlanHistoryObservedCoverage` — the v2.9.x rewrite that
// flips the actionable "N=0 of M=5 scheduled hours" case from invisible (the old
// time-based ≥99 %-of-window heuristic dropped to null) to visible. The string
// feeds the past-tasks list card and the smart-task history-detail hero.
import {
  formatPlanHistoryObservedCoverage,
} from '../packages/shared-domain/src/deferredPlanHistory';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 16, 7, 0, 0); // Sat 16 May 07:00 UTC
const STARTED_MS = DEADLINE_MS - 6 * HOUR_MS;

const buildSnapshot = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [
    { startsAtMs: STARTED_MS, plannedKWh: 2 },
    { startsAtMs: STARTED_MS + HOUR_MS, plannedKWh: 2 },
    { startsAtMs: STARTED_MS + 2 * HOUR_MS, plannedKWh: 2 },
    { startsAtMs: STARTED_MS + 3 * HOUR_MS, plannedKWh: 2 },
    { startsAtMs: STARTED_MS + 4 * HOUR_MS, plannedKWh: 2 },
  ],
  energyNeededKWh: 10,
  planStatus: 'on_track',
  revisedAtMs: STARTED_MS,
  ...overrides,
});

const buildEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-1',
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: STARTED_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 10,
  outcome: 'met',
  metAtMs: DEADLINE_MS - 18 * 60 * 1000,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: buildSnapshot(),
  finalPlan: buildSnapshot(),
  ...overrides,
});

describe('formatPlanHistoryObservedCoverage', () => {
  it('emits "Observed 0 of 5 scheduled hours" when the planner allocated active hours but no observation was recorded', () => {
    // The canonical actionable case: planner thought the device was active across 5 hours
    // but it never drew power. Pre-rewrite, this collapsed to null (the window was fully
    // "observed" because the diagnostic stream was up); the hour-bucket rewrite makes the
    // planner-vs-reality mismatch visible so the user can see something went wrong.
    const line = formatPlanHistoryObservedCoverage(buildEntry({ observedIntervals: [] }));
    expect(line).toBe('Observed 0 of 5 scheduled hours');
  });

  it('counts a scheduled hour as observed when any observed interval overlaps the hour bucket', () => {
    // 2 of 5 buckets overlap an observed interval — the matched buckets are
    // [start, start+1h] and [start+1h, start+2h], both touched by the single interval.
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      observedIntervals: [
        { fromMs: STARTED_MS, toMs: STARTED_MS + 2 * HOUR_MS },
      ],
    }));
    expect(line).toBe('Observed 2 of 5 scheduled hours');
  });

  it('emits "Observed 5 of 5 scheduled hours" when every planned bucket overlaps observation', () => {
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      observedIntervals: [
        { fromMs: STARTED_MS, toMs: STARTED_MS + 5 * HOUR_MS },
      ],
    }));
    expect(line).toBe('Observed 5 of 5 scheduled hours');
  });

  it('singularizes the noun when the plan carries exactly one active hour ("of 1 scheduled hour")', () => {
    // Single-hour plans are common (short EV top-ups, water-heater boost runs scheduled into
    // one cheap slot). The plural-as-default would read "of 1 scheduled hours" — wrong, and
    // the only string-shape edge case in the helper.
    const snapshot = buildSnapshot({
      hours: [{ startsAtMs: STARTED_MS, plannedKWh: 2 }],
    });
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      originalPlan: snapshot,
      finalPlan: snapshot,
      observedIntervals: [],
    }));
    expect(line).toBe('Observed 0 of 1 scheduled hour');
  });

  it('ignores plan hours whose plannedKWh is zero (counts only active-allocation buckets)', () => {
    // 5 buckets total; 2 carry plannedKWh = 0 so M = 3. The first two active buckets
    // are observed; the third is unobserved.
    const snapshot = buildSnapshot({
      hours: [
        { startsAtMs: STARTED_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + HOUR_MS, plannedKWh: 0 },
        { startsAtMs: STARTED_MS + 2 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + 3 * HOUR_MS, plannedKWh: 0 },
        { startsAtMs: STARTED_MS + 4 * HOUR_MS, plannedKWh: 2 },
      ],
    });
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      originalPlan: snapshot,
      finalPlan: snapshot,
      // Cover the first two active buckets [start, start+3h], skip the third (start+4h).
      observedIntervals: [{ fromMs: STARTED_MS, toMs: STARTED_MS + 3 * HOUR_MS }],
    }));
    expect(line).toBe('Observed 2 of 3 scheduled hours');
  });

  it('returns null when no plan was ever recorded (legacy entry, no plan snapshot to count against)', () => {
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      originalPlan: null,
      finalPlan: null,
    }));
    expect(line).toBeNull();
  });

  it('returns null when the plan exists but carries no active-allocation hours (M === 0)', () => {
    const snapshot = buildSnapshot({
      hours: [
        { startsAtMs: STARTED_MS, plannedKWh: 0 },
        { startsAtMs: STARTED_MS + HOUR_MS, plannedKWh: 0 },
      ],
    });
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      originalPlan: snapshot,
      finalPlan: snapshot,
    }));
    expect(line).toBeNull();
  });

  it('returns the backfill-specific copy when the entry was reconstructed from settings', () => {
    // Backfill entries never had a live observation stream — counting "0 of M observed
    // hours" would imply a planner miss when the planner was actually offline. The
    // dedicated copy is honest about the data source.
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      discoveredFrom: 'backfill',
      // Plan absent on backfill entries; the backfill branch must short-circuit before
      // the no-plan check below.
      originalPlan: null,
      finalPlan: null,
    }));
    expect(line).toBe('No observations recorded — smart task reconstructed from settings');
  });

  it('prefers the final plan over the original when both are recorded', () => {
    // Final plan has 3 active hours; original has 5. The helper picks final (planner's
    // last word) so the count denominator reflects the actually-committed schedule.
    const originalPlan = buildSnapshot({
      hours: [
        { startsAtMs: STARTED_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + HOUR_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + 2 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + 3 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + 4 * HOUR_MS, plannedKWh: 2 },
      ],
    });
    const finalPlan = buildSnapshot({
      hours: [
        { startsAtMs: STARTED_MS + 2 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + 3 * HOUR_MS, plannedKWh: 2 },
        { startsAtMs: STARTED_MS + 4 * HOUR_MS, plannedKWh: 2 },
      ],
    });
    const line = formatPlanHistoryObservedCoverage(buildEntry({
      originalPlan,
      finalPlan,
      observedIntervals: [{ fromMs: STARTED_MS + 2 * HOUR_MS, toMs: STARTED_MS + 4 * HOUR_MS }],
    }));
    expect(line).toBe('Observed 2 of 3 scheduled hours');
  });

});
