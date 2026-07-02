import type { PowerTrackerState } from '../../lib/power/tracker';
import { aggregateAndPruneHistory, recordPowerSample } from '../../lib/power/tracker';
import { recordPowerSampleForApp } from '../../lib/power/sampleIngest';
import { getDateKeyInTimeZone } from '../../lib/utils/dateUtils';

// PR-5 solar visibility: tracker-side accounting for the sparse
// generation/export bucket families. The non-solar byte-identity suite below
// is a MERGE GATE — a home with no generation signal and never-negative net
// must produce a persisted state deep-equal with the pre-solar shape (no new
// keys, identical values).

const SOLAR_STATE_KEYS = [
  'generationBuckets',
  'exportBuckets',
  'generationDailyTotals',
  'exportDailyTotals',
  'lastGenerationW',
] as const;

const isoHour = (utcMs: number): string => new Date(utcMs).toISOString();

type SampleOverrides = Partial<Parameters<typeof recordPowerSample>[0]>;

const makeRecorder = () => {
  const state: PowerTrackerState = {};
  const saveState = (nextState: PowerTrackerState) => {
    for (const key of Object.keys(state)) {
      delete (state as Record<string, unknown>)[key];
    }
    Object.assign(state, nextState);
  };
  const record = async (currentPowerW: number, nowMs: number, overrides: SampleOverrides = {}) => {
    await recordPowerSample({
      state,
      currentPowerW,
      nowMs,
      rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
      saveState,
      capacityGuard: undefined,
      ...overrides,
    });
  };
  return { state, record };
};

// Module-level (not nested in the spec) so the callback depth stays within the
// lint budget: drives the REAL ingest pipeline with the minimal seams and
// returns the saved state for the caller to thread into the next call.
const ingestForApp = async (
  tracker: PowerTrackerState,
  nowMs: number,
  generationW?: number,
): Promise<PowerTrackerState> => {
  let saved: PowerTrackerState = tracker;
  await recordPowerSampleForApp({
    currentPowerW: 500,
    generationW,
    nowMs,
    capacitySettings: { limitKw: 10, marginKw: 0.5 },
    getLatestTargetSnapshot: () => [],
    powerTracker: tracker,
    splitControlledUsage: () => ({ controlledKw: null, uncontrolledKw: null }),
    sumBudgetExemptUsage: () => null,
    updateObjectiveProfiles: ({ state }) => state,
    schedulePlanRebuild: vi.fn().mockResolvedValue(undefined),
    saveState: (nextState) => {
      saved = nextState;
    },
  });
  return saved;
};

describe('power tracker solar accounting', () => {
  describe('export accrual', () => {
    it('splits a negative-net interval across UTC hour boundaries and keeps the import clamp', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 0, 1, 0, 50, 0);
      await record(-1500, start);
      await record(-1500, start + 30 * 60 * 1000);

      const bucket0 = isoHour(Date.UTC(2025, 0, 1, 0, 0, 0));
      const bucket1 = isoHour(Date.UTC(2025, 0, 1, 1, 0, 0));
      // 1.5 kW export: 10 min in hour 0 (0.25 kWh), 20 min in hour 1 (0.5 kWh).
      expect(state.exportBuckets?.[bucket0]).toBeCloseTo(0.25, 6);
      expect(state.exportBuckets?.[bucket1]).toBeCloseTo(0.5, 6);
      // Import-clamp regression: the billed total bucket accrues 0 for the
      // export interval (never negative), while exportBuckets carries the kWh.
      expect(state.buckets?.[bucket0]).toBe(0);
      expect(state.buckets?.[bucket1]).toBe(0);
      // Sum identity per hour: importKWh − exportKWh ≡ net energy of the held sample.
      const netKWhHour0 = (-1500 / 1000) * (10 / 60);
      expect((state.buckets?.[bucket0] ?? 0) - (state.exportBuckets?.[bucket0] ?? 0)).toBeCloseTo(netKWhHour0, 6);
    });

    it('creates no exportBuckets key for a positive-net home', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 0, 1, 0, 0, 0);
      await record(1000, start);
      await record(1000, start + 30 * 60 * 1000);
      expect('exportBuckets' in state).toBe(false);
      expect(state.buckets?.[isoHour(start)]).toBeCloseTo(0.5, 6);
    });

    it('negative-junk case: one negative sample in a no-generation home touches export only', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 0, 1, 0, 0, 0);
      await record(1000, start);
      // Single junk negative flow sample, then back to normal.
      await record(-40, start + 10 * 60 * 1000);
      await record(1000, start + 20 * 60 * 1000);
      const key = isoHour(start);
      // Import bucket identical to a 0 W-floored sequence: 1 kW for 10 min,
      // 0 W for 10 min → 1/6 kWh.
      expect(state.buckets?.[key]).toBeCloseTo(1 / 6, 6);
      // The junk export is recorded honestly (negative net IS export)…
      expect(state.exportBuckets?.[key]).toBeCloseTo((40 / 1000) * (10 / 60), 6);
      // …but stays far below the 0.1 kWh/7d card materiality gate.
      expect(state.exportBuckets?.[key]).toBeLessThan(0.1);
      // No generation fields appear.
      expect('generationBuckets' in state).toBe(false);
      expect('lastGenerationW' in state).toBe(false);
    });
  });

  describe('gap guard (ghost-kWh probe)', () => {
    it('mints nothing across a multi-hour silent gap between two generation-bearing samples', async () => {
      // Adversarial probe: 5 kW production + 3 kW export held across an 8 h
      // silent gap (below the 48 h reset) used to integrate the whole gap —
      // 40 kWh ghost generation and 24 kWh ghost export, priced straight into
      // the money lines. Solar accrual must skip any interval over 60 min
      // (the same rule resolveUnreliablePeriods uses to flag the billed
      // bucket as unreliable).
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 5, 1, 8, 0, 0);
      await record(-3000, start, { generationW: 5000 });
      await record(-3000, start + 8 * 60 * 60 * 1000, { generationW: 5000 });
      expect('generationBuckets' in state).toBe(false);
      expect('exportBuckets' in state).toBe(false);
      // The latch still moves with the sample, so normal accrual resumes after.
      expect(state.lastGenerationW).toBe(5000);
      await record(-3000, start + 8 * 60 * 60 * 1000 + 30 * 60 * 1000, { generationW: 5000 });
      expect(state.generationBuckets?.[isoHour(start + 8 * 60 * 60 * 1000)]).toBeCloseTo(2.5, 6);
      expect(state.exportBuckets?.[isoHour(start + 8 * 60 * 60 * 1000)]).toBeCloseTo(1.5, 6);
    });

    it('still accrues a full-hour interval (the boundary of the gap rule)', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 5, 1, 8, 0, 0);
      await record(-1000, start, { generationW: 1000 });
      await record(-1000, start + 60 * 60 * 1000, { generationW: 1000 });
      expect(state.generationBuckets?.[isoHour(start)]).toBeCloseTo(1, 6);
      expect(state.exportBuckets?.[isoHour(start)]).toBeCloseTo(1, 6);
    });
  });

  describe('generation accrual', () => {
    it('accrues the held generation between two finite-generation samples', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 5, 1, 10, 0, 0);
      await record(200, start, { generationW: 500 });
      expect(state.lastGenerationW).toBe(500);
      // Reset path (first sample): latch only, no accrual.
      expect('generationBuckets' in state).toBe(false);
      await record(200, start + 30 * 60 * 1000, { generationW: 1000 });
      expect(state.generationBuckets?.[isoHour(start)]).toBeCloseTo(0.25, 6);
      expect(state.lastGenerationW).toBe(1000);
    });

    it('accrues nothing across a generation-less sample and clears the latch — no back-fill', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 5, 1, 10, 0, 0);
      await record(200, start, { generationW: 1000 });
      await record(200, start + 10 * 60 * 1000, { generationW: 1000 });
      const accruedSoFar = state.generationBuckets?.[isoHour(start)];
      expect(accruedSoFar).toBeCloseTo(1 / 6, 6);
      // Generation-less middle sample: no accrual, latch dropped.
      await record(200, start + 20 * 60 * 1000);
      expect(state.generationBuckets?.[isoHour(start)]).toBeCloseTo(accruedSoFar ?? 0, 9);
      expect('lastGenerationW' in state).toBe(false);
      // Generation returns: still no accrual for the gap (no back-fill), latch re-set.
      await record(200, start + 30 * 60 * 1000, { generationW: 800 });
      expect(state.generationBuckets?.[isoHour(start)]).toBeCloseTo(accruedSoFar ?? 0, 9);
      expect(state.lastGenerationW).toBe(800);
    });

    it('ignores a non-finite generation reading (boundary gate)', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 5, 1, 10, 0, 0);
      await record(200, start, { generationW: Number.NaN });
      expect('lastGenerationW' in state).toBe(false);
      await record(200, start + 10 * 60 * 1000, { generationW: Number.POSITIVE_INFINITY });
      expect('lastGenerationW' in state).toBe(false);
      expect('generationBuckets' in state).toBe(false);
    });

    it('skips zero-generation intervals so night hours stay sparse', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 5, 1, 1, 0, 0);
      await record(200, start, { generationW: 0 });
      await record(200, start + 30 * 60 * 1000, { generationW: 0 });
      expect(state.lastGenerationW).toBe(0);
      expect('generationBuckets' in state).toBe(false);
    });
  });

  describe('non-solar byte-identity (merge gate)', () => {
    it('a positive-net, no-generation sequence plus a prune pass persists the exact pre-solar shape', async () => {
      const { state, record } = makeRecorder();
      const start = Date.UTC(2025, 0, 1, 0, 0, 0);
      await record(1000, start);
      await record(1000, start + 30 * 60 * 1000);

      for (const key of SOLAR_STATE_KEYS) {
        expect(`${key} in sampled state: ${key in state}`).toBe(`${key} in sampled state: false`);
      }
      // The persisted artifact (what Homey settings JSON-serializes) must be
      // deep-equal with the pre-solar output for the same sequence.
      const bucketKey = isoHour(start);
      expect(JSON.parse(JSON.stringify(state))).toStrictEqual({
        buckets: { [bucketKey]: 0.5 },
        hourlySampleCounts: { [bucketKey]: 2 },
        hourlyBudgets: {},
        controlledBuckets: {},
        uncontrolledBuckets: {},
        exemptBuckets: {},
        lastTimestamp: start + 30 * 60 * 1000,
        lastPowerW: 1000,
      });

      vi.useFakeTimers();
      try {
        vi.setSystemTime(start + 60 * 60 * 1000);
        const pruned = aggregateAndPruneHistory(state);
        for (const key of SOLAR_STATE_KEYS) {
          expect(`${key} in pruned state: ${key in pruned}`).toBe(`${key} in pruned state: false`);
        }
        expect(JSON.parse(JSON.stringify(pruned))).toStrictEqual({
          buckets: { [bucketKey]: 0.5 },
          hourlySampleCounts: { [bucketKey]: 2 },
          hourlyBudgets: {},
          dailyBudgetCaps: {},
          dailyTotals: {},
          hourlyAverages: {},
          controlledBuckets: {},
          uncontrolledBuckets: {},
          exemptBuckets: {},
          controlledDailyTotals: {},
          uncontrolledDailyTotals: {},
          exemptDailyTotals: {},
          controlledHourlyAverages: {},
          uncontrolledHourlyAverages: {},
          exemptHourlyAverages: {},
          lastTimestamp: start + 30 * 60 * 1000,
          lastPowerW: 1000,
          unreliablePeriods: [],
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('prune folds', () => {
    it('folds aged generation/export hours into local-day dailyTotals and keeps absent families absent', () => {
      vi.useFakeTimers();
      try {
        const agedUtcMs = Date.UTC(2025, 5, 10, 10, 0, 0);
        vi.setSystemTime(agedUtcMs + 35 * 24 * 60 * 60 * 1000);
        const dateKey = getDateKeyInTimeZone(new Date(agedUtcMs), 'Europe/Oslo');

        const pruned = aggregateAndPruneHistory({
          buckets: {},
          generationBuckets: { [isoHour(agedUtcMs)]: 2.4, [isoHour(agedUtcMs + 60 * 60 * 1000)]: 1.6 },
        }, { timeZone: 'Europe/Oslo' });

        expect(pruned.generationBuckets).toEqual({});
        expect(pruned.generationDailyTotals).toEqual({ [dateKey]: 4 });
        // Export family untouched in this home: no keys appear.
        expect('exportBuckets' in pruned).toBe(false);
        expect('exportDailyTotals' in pruned).toBe(false);
        // The averages slice is discarded — no typical-day solar state is persisted.
        expect('generationHourlyAverages' in pruned).toBe(false);
        expect('exportHourlyAverages' in pruned).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps recent solar hours in the hourly families untouched', () => {
      vi.useFakeTimers();
      try {
        const recentUtcMs = Date.UTC(2025, 5, 10, 10, 0, 0);
        vi.setSystemTime(recentUtcMs + 2 * 60 * 60 * 1000);
        const pruned = aggregateAndPruneHistory({
          buckets: {},
          exportBuckets: { [isoHour(recentUtcMs)]: 0.8 },
        }, { timeZone: 'Europe/Oslo' });
        expect(pruned.exportBuckets).toEqual({ [isoHour(recentUtcMs)]: 0.8 });
        expect(pruned.exportDailyTotals).toEqual({});
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sample ingest passthrough', () => {
    it('carries generationW through recordPowerSampleForApp into the tracker state', async () => {
      const start = Date.UTC(2025, 5, 1, 12, 0, 0);
      let tracker: PowerTrackerState = {};
      tracker = await ingestForApp(tracker, start, 2000);
      expect(tracker.lastGenerationW).toBe(2000);
      tracker = await ingestForApp(tracker, start + 30 * 60 * 1000, 2000);
      expect(tracker.generationBuckets?.[isoHour(start)]).toBeCloseTo(1, 6);
      // Generation-less ingest drops the latch.
      tracker = await ingestForApp(tracker, start + 40 * 60 * 1000);
      expect('lastGenerationW' in tracker).toBe(false);
    });
  });
});
