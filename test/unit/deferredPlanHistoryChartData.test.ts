// Unit tests for the smart-task history-detail chart data resolver (v2.7.2 PR 4).
// Produces the actual-vs-plan trajectory payload the detail page renders: a
// planned staircase (hours × kwhPerUnitMean integrated from start progress),
// an observed line from `progressSamples[]`, a target reference, and an
// optional metAtMs marker. Falls back to `legacy_kwh` mode when neither input
// is available so v3 entries still get a chart.
import {
  resolveHistoryDetailChartData,
  historyDetailChartLabels,
  type DeferredPlanHistoryChartPoint,
} from '../../packages/shared-domain/src/deferredPlanHistory';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';

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
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedPlanHistoryEntry({
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

    it('re-anchors the revised staircase at the measured progress at revisedAtMs', () => {
      // Revision computed 2 h into the run, when the device had already reached
      // 60 °C — the revised line must start there, not re-climb from the 50 °C
      // task-start temperature.
      const revisedAtMs = START_MS + 2 * HOUR_MS;
      const original = buildSnapshot({
        hours: [
          { startsAtMs: START_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs: START_MS,
        kwhPerUnitMean: 0.5,
      });
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: original,
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 56, valuePercent: null },
          { atMs: revisedAtMs, valueC: 60, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      // First point sits at the revision time, anchored at the measured 60 °C.
      expect(data.plannedFinal![0]).toEqual({ atMs: revisedAtMs, value: 60 });
      // The line only climbs from there (1 kWh / 0.5 = +2 °C/h); it never dips
      // back toward the start temperature.
      expect(Math.min(...data.plannedFinal!.map(observedPointValue))).toBeGreaterThanOrEqual(60);
    });

    it('interpolates from start progress when the only sample is after revisedAtMs (seeded start overwritten)', () => {
      // Replan in the task's first hour: the recorder overwrote the seeded
      // start sample with a later same-hour reading, so the only observed point
      // is AFTER revisedAtMs. The seeded startProgress bracket lets the anchor
      // interpolate from start rather than re-climbing from the start-anchored
      // plan.
      const revisedAtMs = START_MS + 2 * HOUR_MS;
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({ revisedAtMs: START_MS }),
        finalPlan: final,
        progressSamples: [
          { atMs: revisedAtMs + HOUR_MS, valueC: 62, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      // Interpolate 50 @ windowStart → 62 @ +3h at +2h = 58, anchored at the revision.
      expect(data.plannedFinal![0]).toEqual({ atMs: revisedAtMs, value: 58 });
    });

    it('keeps the start anchor when the revision coincides with the window start', () => {
      // revisedAtMs === windowStart: no mid-run replan to re-anchor on, even
      // though observed samples exist.
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs: START_MS,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({ revisedAtMs: START_MS }),
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 58, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      expect(data.plannedFinal![0]).toEqual({ atMs: START_MS, value: 50 });
    });

    it('anchors the no-original fallback primary staircase at observed reality', () => {
      // Entry with only a finalPlan (no usable originalPlan): the final plan is
      // the only real schedule, so it becomes the primary line — anchored at the
      // observed value where its booked heating starts (the first booked hour),
      // not re-climbing from the task-start progress. With no original to
      // contrast against, no "Revised trajectory" overlay is drawn.
      const firstBookedMs = START_MS + 2 * HOUR_MS;
      const final = buildSnapshot({
        hours: [
          { startsAtMs: firstBookedMs, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs: firstBookedMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: null,
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: firstBookedMs, valueC: 60, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      // Booked heating starts at +2h where the device had measured 60 °C.
      expect(data.plannedOriginal[0]).toEqual({ atMs: firstBookedMs, value: 60 });
      expect(data.plannedFinal).toBeNull();
    });

    it('draws a succeeded draw-down/reheat run anchored at the trough, capped at target', () => {
      // Satisfied-then-drifted: tank at 65 °C, target 40 (met at creation), so
      // the recorder writes an empty-hours / rate-less original. A draw pulls it
      // to 20 °C; PELS books reheat (the finalPlan), which reaches 40 by the
      // deadline. The chart must show the reheat anchored at the ~20 °C trough
      // rising to 40 — not the start-anchored 65 → 85 overshoot — and the
      // measured line shows the full 65 → 20 → 40 arc.
      const reheatStart = START_MS + 2 * HOUR_MS;
      const final = buildSnapshot({
        hours: [
          { startsAtMs: reheatStart, plannedKWh: 5 },
          { startsAtMs: reheatStart + HOUR_MS, plannedKWh: 5 },
        ],
        revisedAtMs: reheatStart,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        targetTemperatureC: 40,
        startProgressC: 65,
        finalProgressC: 40,
        outcome: 'met',
        metAtMs: DEADLINE_MS - HOUR_MS,
        // The recorder promotes the richest schedule (the booked reheat) into
        // BOTH originalPlan and finalPlan (`pickRicherSnapshot`); the empty
        // satisfied-window seed never survives to a finalized entry. start ≥
        // target routes the primary through the trough anchor regardless.
        originalPlan: final,
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 65, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: 40, valuePercent: null },
          { atMs: reheatStart, valueC: 20, valuePercent: null },
          { atMs: reheatStart + HOUR_MS, valueC: 32, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 40, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      expect(data.plannedOriginal[0]).toEqual({ atMs: reheatStart, value: 20 });
      const values = data.plannedOriginal.map(observedPointValue);
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!); // never descends
        expect(values[i]!).toBeLessThanOrEqual(40); // never exceeds target
      }
      expect(values.at(-1)).toBe(40);
      // No redundant revised overlay — one clean line.
      expect(data.plannedFinal).toBeNull();
      // Observed shows the full drain-then-reheat arc.
      expect(data.observed.map(observedPointValue)).toEqual([65, 40, 20, 32, 40]);
    });

    it('draws the reheat plan for a missed draw-down/reheat run (not omitted)', () => {
      // Same shape, but the reheat never lands: measured stays low. The planned
      // reheat (anchored at the trough → target) must still be drawn so the user
      // sees the intended reheat that PELS booked but did not achieve.
      const reheatStart = START_MS + 2 * HOUR_MS;
      const final = buildSnapshot({
        hours: [
          { startsAtMs: reheatStart, plannedKWh: 5 },
          { startsAtMs: reheatStart + HOUR_MS, plannedKWh: 5 },
        ],
        revisedAtMs: reheatStart,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        targetTemperatureC: 40,
        startProgressC: 65,
        finalProgressC: 24,
        outcome: 'missed',
        metAtMs: null,
        // Richest schedule promoted into originalPlan (see succeeded case).
        originalPlan: final,
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 65, valuePercent: null },
          { atMs: reheatStart, valueC: 20, valuePercent: null },
          { atMs: DEADLINE_MS - HOUR_MS, valueC: 24, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.mode).toBe('trajectory');
      // Reheat plan drawn (not omitted), anchored at the trough, ending at target.
      expect(data.plannedOriginal.length).toBeGreaterThan(0);
      expect(data.plannedOriginal[0]).toEqual({ atMs: reheatStart, value: 20 });
      expect(data.plannedOriginal.at(-1)?.value).toBe(40);
      // Measured ends low.
      expect(data.observed.at(-1)?.value).toBe(24);
    });

    it('prorates a revision hour that straddles revisedAtMs', () => {
      // Revision computed 30 min into the START_MS+2h hour: that hour already
      // delivered its first half before the anchor, so only the second half's
      // booked energy is credited forward (the first half is on the observed
      // line). 1 kWh * 0.5 / 0.5 kwhPerUnitMean = +1 °C for that hour, not +2.
      const revisedAtMs = START_MS + 2 * HOUR_MS + HOUR_MS / 2;
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 }, // straddles anchor
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({ revisedAtMs: START_MS }),
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: revisedAtMs, valueC: 60, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      // Anchored at the measured 60 °C at the revision time.
      expect(data.plannedFinal![0]).toEqual({ atMs: revisedAtMs, value: 60 });
      // Straddling hour credits only its post-anchor half: 60 → 61 by 3h.
      expect(data.plannedFinal![1]?.value).toBeCloseTo(61, 5);
      // Next full hour adds +2 °C: 61 → 63 by 4h.
      expect(data.plannedFinal![2]?.value).toBeCloseTo(63, 5);
    });

    it('does not prorate a straddling hour that is already trimmed (coversFromMs set)', () => {
      // Same mid-hour revision, but the current hour carries `coversFromMs`: the
      // planner already trimmed it to the post-revision remainder, so its
      // (smaller) plannedKWh must be added whole — prorating it would double-trim.
      const revisedAtMs = START_MS + 2 * HOUR_MS + HOUR_MS / 2;
      const final = buildSnapshot({
        hours: [
          // Trimmed current hour: 0.5 kWh already scoped to [2.5h, 3h).
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 0.5, coversFromMs: revisedAtMs },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({ revisedAtMs: START_MS }),
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: revisedAtMs, valueC: 60, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      expect(data.plannedFinal![0]).toEqual({ atMs: revisedAtMs, value: 60 });
      // Trimmed hour adds its full 0.5 kWh (not prorated again): 0.5 / 0.5 = +1 °C → 61.
      expect(data.plannedFinal![1]?.value).toBeCloseTo(61, 5);
      // Next full hour adds +2 °C → 63.
      expect(data.plannedFinal![2]?.value).toBeCloseTo(63, 5);
    });

    it('interpolates the anchor when no sample lands exactly at revisedAtMs', () => {
      // The recorder keeps one sample per hour, so a mid-hour revision usually
      // has no sample at revisedAtMs. Interpolate between the bracketing samples
      // rather than snapping to the stale prior-hour reading.
      const revisedAtMs = START_MS + 2 * HOUR_MS;
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 1 },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({ revisedAtMs: START_MS }),
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS + HOUR_MS, valueC: 54, valuePercent: null },      // before
          { atMs: START_MS + 3 * HOUR_MS, valueC: 64, valuePercent: null },  // after
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      // 54 @ +1h → 64 @ +3h, interpolated at +2h = 59 (not the stale 54).
      expect(data.plannedFinal![0]).toEqual({ atMs: revisedAtMs, value: 59 });
    });

    it('prorates a trimmed hour carried forward with coversFromMs before the anchor', () => {
      // An earlier same-hour revision trimmed this hour (coversFromMs = 2h20m)
      // and its floor was carried past a later revision (revisedAtMs = 2h40m).
      // The [2h20m, 2h40m] sliver predates the anchor, so the trimmed energy is
      // prorated over its covered span, not added whole.
      const revisedAtMs = START_MS + 2 * HOUR_MS + (2 * HOUR_MS) / 3; // 2h40m
      const coversFromMs = START_MS + 2 * HOUR_MS + HOUR_MS / 3; // 2h20m
      const final = buildSnapshot({
        hours: [
          { startsAtMs: START_MS + 2 * HOUR_MS, plannedKWh: 0.5, coversFromMs },
          { startsAtMs: START_MS + 3 * HOUR_MS, plannedKWh: 1 },
        ],
        revisedAtMs,
        kwhPerUnitMean: 0.5,
      });
      const entry = buildEntry({
        startProgressC: 50,
        originalPlan: buildSnapshot({ revisedAtMs: START_MS }),
        finalPlan: final,
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: revisedAtMs, valueC: 60, valuePercent: null },
        ],
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.plannedFinal).not.toBeNull();
      expect(data.plannedFinal![0]).toEqual({ atMs: revisedAtMs, value: 60 });
      // Covered span [2h20m,3h]=40min; post-anchor [2h40m,3h]=20min → fraction 0.5.
      // 0.5 kWh * 0.5 / 0.5 = +0.5 °C → 60.5 (not the whole +1 °C → 61).
      expect(data.plannedFinal![1]?.value).toBeCloseTo(60.5, 5);
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

    it('skips samples with no value in either column', () => {
      // Defensive — should not happen with the v4 recorder, but the helper
      // must not crash if a sample carries no usable value at all.
      const entry = buildEntry({
        objectiveKind: 'temperature',
        originalPlan: buildSnapshot(),
        progressSamples: [
          { atMs: START_MS, valueC: 50, valuePercent: null },
          { atMs: START_MS + HOUR_MS, valueC: null, valuePercent: null },
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

    it('places metMarkerValue on the target for target-reached met runs', () => {
      const entry = buildEntry({
        outcome: 'met',
        metReason: undefined,
        metAtMs: DEADLINE_MS - HOUR_MS,
        finalProgressC: 65,
        targetTemperatureC: 65,
        originalPlan: buildSnapshot(),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.metMarkerValue).toBe(65);
    });

    it('places metMarkerValue on the frozen finalProgress for stalled met runs', () => {
      // The chart marker must land on the observed line (where the device
      // actually stopped) rather than the target line (which the run
      // never crossed). Connected 300 regression: target 65, plateau 61.8.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled',
        metAtMs: DEADLINE_MS - 3 * HOUR_MS,
        finalProgressC: 61.8,
        targetTemperatureC: 65,
        originalPlan: buildSnapshot(),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.metMarkerValue).toBeCloseTo(61.8, 1);
      // `target` keeps pointing at the configured setpoint so the
      // horizontal reference line still renders.
      expect(data.target).toBe(65);
    });

    it('places metMarkerValue on the frozen finalProgress for stalled_device_capped met runs', () => {
      // Connected 300 capped-internally regression: the chart marker lands
      // on the plateau the device reached against its own setpoint cap,
      // not the higher PELS-commanded target. Target line still renders.
      const entry = buildEntry({
        outcome: 'met',
        metReason: 'stalled_device_capped',
        metAtMs: DEADLINE_MS - 3 * HOUR_MS,
        finalProgressC: 58,
        targetTemperatureC: 65,
        originalPlan: buildSnapshot(),
      });
      const data = resolveHistoryDetailChartData(entry);
      expect(data.metMarkerValue).toBeCloseTo(58, 1);
      expect(data.target).toBe(65);
    });

    it('returns null metMarkerValue when no marker timestamp exists', () => {
      const missedEntry = buildEntry({
        outcome: 'missed',
        metAtMs: null,
        originalPlan: buildSnapshot(),
      });
      expect(resolveHistoryDetailChartData(missedEntry).metMarkerValue).toBeNull();
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

// Covers the v2.7.2 PR 4 chart-string lift: per `feedback_ui_text_shared_with_logs`,
// the user-visible series names / card titles / toggle copy live in
// shared-domain so runtime log breadcrumbs can read the same strings the
// chart legend renders. Assertions pin the exact shipped strings so a copy
// tweak surfaces here rather than silently in the UI.
describe('historyDetailChartLabels', () => {
  it('exposes every expected key with mode-agnostic series + toggle copy', () => {
    const labels = historyDetailChartLabels('trajectory');
    expect(Object.keys(labels).sort()).toEqual([
      'cardTitle',
      'collapseToggleLabel',
      'expandToggleLabel',
      'fallbackNote',
      'formatObservedNotRecorded',
      'formatTrajectoryAriaLabel',
      'metMarkName',
      'plannedRevisedSeriesName',
      'plannedSeriesName',
      'targetSeriesName',
    ]);
    expect(labels.plannedSeriesName).toBe('Planned trajectory');
    expect(labels.plannedRevisedSeriesName).toBe('Revised trajectory');
    expect(labels.targetSeriesName).toBe('Target');
    expect(labels.metMarkName).toBe('Reached target');
    expect(labels.expandToggleLabel).toBe('View details');
    expect(labels.collapseToggleLabel).toBe('Hide details');
  });

  it('returns the trajectory card title with no fallback note in trajectory mode', () => {
    const labels = historyDetailChartLabels('trajectory');
    expect(labels.cardTitle).toBe('Progress history');
    expect(labels.fallbackNote).toBeNull();
  });

  it('returns the legacy card title + fallback note in legacy_kwh mode', () => {
    const labels = historyDetailChartLabels('legacy_kwh');
    expect(labels.cardTitle).toBe('Scheduled vs observed');
    expect(labels.fallbackNote).toBe('Schedule only — observations not recorded for this run.');
  });

  it('composes the parametric tooltip + aria-label strings with the caller-supplied names', () => {
    const labels = historyDetailChartLabels('trajectory');
    expect(labels.formatObservedNotRecorded('Measured Heating')).toBe('Measured Heating — not recorded');
    expect(labels.formatTrajectoryAriaLabel('Connected 300')).toBe('Progress trajectory for Connected 300');
    // Caller-resolved fallback: the view passes `'this smart task'` when no
    // device name is recorded — shared-domain just templates whatever string
    // the caller hands in.
    expect(labels.formatTrajectoryAriaLabel('this smart task')).toBe('Progress trajectory for this smart task');
  });
});
