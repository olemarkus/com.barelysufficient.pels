// Unit tests for the smart-task history-detail chart data resolver (v2.7.2 PR 4).
// Produces the actual-vs-plan trajectory payload the detail page renders: a
// planned staircase (hours × kwhPerUnitMean integrated from start progress),
// an observed line from `progressSamples[]`, a target reference, and an
// optional metAtMs marker. Falls back to `legacy_kwh` mode when neither input
// is available so v3 entries still get a chart.
import {
  resolveHistoryDetailChartData,
  type DeferredPlanHistoryChartPoint,
} from '../packages/shared-domain/src/deferredPlanHistory';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 16, 16, 0, 0); // Sat 16 May 16:00 UTC
const START_MS = DEADLINE_MS - 6 * HOUR_MS; // 6 hours before deadline

// Tiny accessors so the test's nested-callback depth stays inside ESLint's
// 3-deep limit when verifying observed-point columns.
const observedPointValue = (point: DeferredPlanHistoryChartPoint): number => point.value;
const observedPointAtMs = (point: DeferredPlanHistoryChartPoint): number => point.atMs;

const buildSnapshot = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [
    { startsAtMs: START_MS, plannedKWh: 1 },
    { startsAtMs: START_MS + HOUR_MS, plannedKWh: 1 },
  ],
  energyNeededKWh: 2,
  planStatus: 'on_track',
  revisedAtMs: START_MS,
  kwhPerUnitMean: 0.5, // 0.5 kWh per °C → 1 kWh raises progress by 2 °C
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
  startedAtMs: START_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 4,
  outcome: 'met',
  metAtMs: DEADLINE_MS - HOUR_MS,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  progressSamples: [],
  ...overrides,
});

describe('resolveHistoryDetailChartData', () => {
  describe('mode resolution', () => {
    it('returns legacy_kwh when no samples and no kwhPerUnitMean were recorded', () => {
      // v3 entry that predates PR 1's recorder: originalPlan exists but
      // without `kwhPerUnitMean`, no `progressSamples` array.
      const entry = buildEntry({
        originalPlan: buildSnapshot({ kwhPerUnitMean: undefined }),
        finalPlan: null,
        progressSamples: undefined,
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('legacy_kwh');
      expect(data.unit).toBeNull();
      expect(data.plannedOriginal).toEqual([]);
      expect(data.observed).toEqual([]);
    });

    it('returns trajectory when the original snapshot carries kwhPerUnitMean', () => {
      const entry = buildEntry({
        originalPlan: buildSnapshot(),
        finalPlan: null,
        progressSamples: undefined,
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      expect(data.unit).toBe('°C');
    });

    it('returns trajectory when progressSamples has ≥ 2 entries even with no kwhPerUnitMean', () => {
      const entry = buildEntry({
        originalPlan: buildSnapshot({ kwhPerUnitMean: undefined }),
        finalPlan: null,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 53, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      expect(data.observed).toHaveLength(2);
      // Without kwhPerUnitMean the staircase stays empty; the observed line
      // alone is enough to justify trajectory mode.
      expect(data.plannedOriginal).toEqual([]);
    });

    it('stays in legacy_kwh when only one observation sample landed and no rate exists', () => {
      const entry = buildEntry({
        originalPlan: buildSnapshot({ kwhPerUnitMean: undefined }),
        finalPlan: null,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('legacy_kwh');
    });
  });

  describe('planned staircase integration', () => {
    it('integrates hours × kwhPerUnitMean from startProgressC for temperature objectives', () => {
      // Two 1-kWh hours at 0.5 kWh/°C → +2 °C total. Anchor[0]=start, then
      // each end-of-hour point reflects the cumulative rise.
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({
          hours: [
            { startsAtMs: START_MS, plannedKWh: 1 },
            { startsAtMs: START_MS + HOUR_MS, plannedKWh: 1 },
          ],
          kwhPerUnitMean: 0.5,
        }),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      expect(data.plannedOriginal).toEqual([
        { atMs: START_MS, value: 50 },
        { atMs: START_MS + HOUR_MS, value: 52 },
        { atMs: START_MS + 2 * HOUR_MS, value: 54 },
      ]);
    });

    it('integrates from startProgressPercent for EV SoC objectives', () => {
      // EV SoC: kwhPerUnitMean = 0.5 kWh/% → 2 kWh raises by 4 percentage
      // points (2 / 0.5).
      const entry = buildEntry({
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 80,
        originalPlan: buildSnapshot({
          hours: [
            { startsAtMs: START_MS, plannedKWh: 2 },
            { startsAtMs: START_MS + HOUR_MS, plannedKWh: 2 },
          ],
          kwhPerUnitMean: 0.5,
        }),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      expect(data.unit).toBe('%');
      expect(data.plannedOriginal).toEqual([
        { atMs: START_MS, value: 30 },
        { atMs: START_MS + HOUR_MS, value: 34 },
        { atMs: START_MS + 2 * HOUR_MS, value: 38 },
      ]);
    });

    it('clamps the last anchor to the deadline so an overrun plan does not extend past windowEndMs', () => {
      const entry = buildEntry({
        originalPlan: buildSnapshot({
          hours: [
            { startsAtMs: DEADLINE_MS - HOUR_MS / 2, plannedKWh: 1 },
          ],
          kwhPerUnitMean: 0.5,
        }),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedOriginal.at(-1)?.atMs).toBe(DEADLINE_MS);
    });

    it('keeps idle gaps flat by anchoring the staircase at non-contiguous hour starts', () => {
      // Non-contiguous EV schedule: 02:00 + 06:00 with no plan between.
      // The staircase must read as: flat from windowStart → 02:00, riser
      // across 02:00 → 03:00, flat from 03:00 → 06:00, second riser across
      // 06:00 → 07:00. Without the hour-start anchor the line would imply
      // a smooth climb from 03:00 to 07:00.
      const entry = buildEntry({
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        finalProgressC: null,
        finalProgressPercent: 80,
        startedAtMs: START_MS,
        deadlineAtMs: START_MS + 8 * HOUR_MS,
        originalPlan: buildSnapshot({
          hours: [
            { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 2 },
            { startsAtMs: START_MS + 6 * HOUR_MS, plannedKWh: 2 },
          ],
          kwhPerUnitMean: 0.5,
        }),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedOriginal).toEqual([
        { atMs: START_MS, value: 30 },
        // Hour 1 starts at +2h → anchor at +2h carrying the windowStart
        // value (30), then riser to 34 at +3h.
        { atMs: START_MS + 2 * HOUR_MS, value: 30 },
        { atMs: START_MS + 3 * HOUR_MS, value: 34 },
        // Idle gap +3h..+6h → anchor at +6h carrying 34, then riser to 38
        // at +7h.
        { atMs: START_MS + 6 * HOUR_MS, value: 34 },
        { atMs: START_MS + 7 * HOUR_MS, value: 38 },
      ]);
    });

    it('returns an empty staircase when startProgress is null', () => {
      const entry = buildEntry({
        startProgressC: null,
        originalPlan: buildSnapshot(),
        progressSamples: [
          // Force trajectory mode via observed samples so the test verifies
          // the staircase-empty branch specifically.
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 53, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      expect(data.plannedOriginal).toEqual([]);
    });
  });

  describe('plannedFinal overlay', () => {
    it('omits plannedFinal when the original and final staircases are identical', () => {
      const snapshot = buildSnapshot();
      const entry = buildEntry({ originalPlan: snapshot, finalPlan: snapshot });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).toBeNull();
    });

    it('surfaces plannedFinal when the run replanned with a different schedule', () => {
      const original = buildSnapshot({
        hours: [
          { startsAtMs: START_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + HOUR_MS, plannedKWh: 1 },
        ],
        kwhPerUnitMean: 0.5,
      });
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({ originalPlan: original, finalPlan: final });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      expect(data.plannedFinal!.length).toBeGreaterThan(0);
      // The two staircases anchor at the same start progress but climb at
      // different times — the divergence is enough to surface the overlay.
      expect(data.plannedFinal![1]?.atMs).not.toBe(data.plannedOriginal[1]?.atMs);
    });
  });

  describe('observed samples', () => {
    it('maps temperature samples to valueC in unit space', () => {
      const entry = buildEntry({
        objectiveKind: 'temperature',
        originalPlan: buildSnapshot(),
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 55, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.observed).toEqual([
        { atMs: START_MS, value: 50 },
        { atMs: START_MS + HOUR_MS, value: 55 },
      ]);
    });

    it('skips samples whose kind-specific value is null', () => {
      // Defensive — should not happen with the v4 recorder, but the helper
      // must not crash if a sample lacks the field for the entry's kind.
      const entry = buildEntry({
        objectiveKind: 'temperature',
        originalPlan: buildSnapshot(),
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: null, valuePercent: 30 },
          { atMs: START_MS + 2 * HOUR_MS, valueC: 53, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      const values = data.observed.map(observedPointValue);
      expect(values).toEqual([50, 53]);
    });

    it('sorts samples by atMs even if the recorder drained out-of-order', () => {
      const entry = buildEntry({
        originalPlan: buildSnapshot(),
        progressSamples: [
          { atMs: START_MS + 2 * HOUR_MS, valueC: 55, valuePercent: null },
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 53, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      const times = data.observed.map(observedPointAtMs);
      expect(times).toEqual([
        START_MS,
        START_MS + HOUR_MS,
        START_MS + 2 * HOUR_MS,
      ]);
    });
  });

  describe('target and metAtMs', () => {
    it('surfaces the kind-specific target value', () => {
      const tempEntry = buildEntry({
        objectiveKind: 'temperature',
        targetTemperatureC: 65,
        targetPercent: null,
        originalPlan: buildSnapshot(),
      });
      expect(resolveHistoryDetailChartData(tempEntry).target).toBe(65);
      const evEntry = buildEntry({
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 80,
        startProgressC: null,
        startProgressPercent: 30,
        originalPlan: buildSnapshot(),
      });
      expect(resolveHistoryDetailChartData(evEntry).target).toBe(80);
    });

    it('surfaces metAtMs only on met outcomes', () => {
      const metEntry = buildEntry({
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        originalPlan: buildSnapshot(),
      });
      expect(resolveHistoryDetailChartData(metEntry).metAtMs).toBe(DEADLINE_MS - HOUR_MS);
      const missedEntry = buildEntry({
        outcome: 'missed',
        metAtMs: null,
        originalPlan: buildSnapshot(),
      });
      expect(resolveHistoryDetailChartData(missedEntry).metAtMs).toBeNull();
    });
  });

  describe('window', () => {
    it('echoes startedAtMs / deadlineAtMs onto the payload', () => {
      const entry = buildEntry({ originalPlan: buildSnapshot() });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.windowStartMs).toBe(START_MS);
      expect(data.windowEndMs).toBe(DEADLINE_MS);
    });
  });
});
