import type { DeferredObjectivePlanHistoryProgressSample } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives';
import {
  drainProgressSamples,
  PROGRESS_SAMPLES_PER_ENTRY_CAP,
  progressSampleBucketMs,
  rebucketProgressSamples,
  recordProgressSample,
  seedProgressSamples,
} from '../../lib/objectives/deferredObjectives/planHistoryV4Helpers';
import {
  mergeRecord,
  promoteRecordToStalled,
  startRecord,
} from '../../lib/objectives/deferredObjectives/planHistoryInProgressState';

const QUARTER_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Fully-typed temperature diagnostic so the spec needs no `as any`. Only the
// fields the progress-sample helpers read (`objectiveKind`, `reasonCode`,
// `currentTemperatureC`, `currentValue`) vary per test.
const makeDiag = (
  overrides: Partial<DeferredObjectiveDiagnostic> = {},
): DeferredObjectiveDiagnostic => {
  // Spreading a `Partial<DeferredObjectiveDiagnostic>` (a kind-discriminated
  // union) widens the literal back to the union; the temperature defaults above
  // keep it a valid temperature diagnostic at runtime, so cast rather than annotate.
  const diag = {
    deviceId: 'dev',
    deviceName: 'Water Heater',
    objectiveId: 'dev:temperature',
    objectiveKind: 'temperature',
    enforcement: 'soft',
    status: 'on_track',
    reasonCode: 'planned_with_margin',
    targetPercent: null,
    currentPercent: null,
    targetTemperatureC: 65,
    currentTemperatureC: 50,
    currentValue: 50,
    targetValue: 65,
    deadlineAtMs: 6 * HOUR_MS,
    deadlineLocalTime: '06:00',
    energyNeededKWh: 22.5,
    kWhPerUnitBanded: 1.5,
    kwhPerUnitLearnedMean: 1.5,
    rateConfidence: 'high',
    displayConfidence: 'high',
    kwhPerUnitSource: 'learned',
    kwhPerUnitAcceptedSamples: 10,
    kwhPerUnitLastAcceptedAtMs: 0,
    planningSpeedKw: 2,
    horizonBucketCount: 6,
    dailyBudgetExhaustedBucketCount: 0,
    expectedStepId: 'low',
    ...overrides,
  } as DeferredObjectiveDiagnostic;
  return {
    ...diag,
    currentValue: overrides.currentValue
      ?? (diag.objectiveKind === 'temperature' ? diag.currentTemperatureC : diag.currentPercent),
  };
};

const tempDiag = (currentTemperatureC: number): DeferredObjectiveDiagnostic => (
  makeDiag({ currentTemperatureC, currentValue: currentTemperatureC })
);

describe('progressSampleBucketMs', () => {
  it('floors timestamps onto the 15-minute grid with pure UTC-ms arithmetic', () => {
    expect(progressSampleBucketMs(0)).toBe(0);
    expect(progressSampleBucketMs(QUARTER_MS - 1)).toBe(0);
    expect(progressSampleBucketMs(QUARTER_MS)).toBe(QUARTER_MS);
    expect(progressSampleBucketMs(QUARTER_MS + 1)).toBe(QUARTER_MS);
    // A real epoch timestamp lands on its containing quarter-hour. The math
    // is timezone-free (no local-time arithmetic), so DST transitions
    // (23/25 h days) cannot skew the grid.
    const tenPastSeven = Date.UTC(2026, 2, 29, 7, 10, 33);
    expect(progressSampleBucketMs(tenPastSeven)).toBe(Date.UTC(2026, 2, 29, 7, 0, 0));
    const fiftyPastSeven = Date.UTC(2026, 2, 29, 7, 50, 0);
    expect(progressSampleBucketMs(fiftyPastSeven)).toBe(Date.UTC(2026, 2, 29, 7, 45, 0));
  });
});

describe('recordProgressSample (15-minute grid)', () => {
  it('keeps one sample per quarter-hour bucket, separating readings an hour grid would merge', () => {
    let ring = seedProgressSamples(tempDiag(50), 0);
    ring = recordProgressSample(ring, tempDiag(51), 20 * 60 * 1000);
    ring = recordProgressSample(ring, tempDiag(52), 40 * 60 * 1000);
    ring = recordProgressSample(ring, tempDiag(53), 50 * 60 * 1000);
    // 0:00 / 0:20 / 0:40 / 0:50 are four distinct 15-minute buckets — the
    // old hourly grid would have collapsed them into a single sample.
    expect(drainProgressSamples(ring).map((s) => s.valueC)).toEqual([50, 51, 52, 53]);
  });

  it('upserts within a bucket: latest reading wins and keeps its real timestamp', () => {
    let ring = seedProgressSamples(tempDiag(50), 0);
    ring = recordProgressSample(ring, tempDiag(50.4), 5 * 60 * 1000);
    ring = recordProgressSample(ring, tempDiag(50.9), 14 * 60 * 1000);
    const drained = drainProgressSamples(ring);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.valueC).toBe(50.9);
    // The sample keeps the observation's real time, not the bucket start.
    expect(drained[0]!.atMs).toBe(14 * 60 * 1000);
  });

  it('drops untrustworthy readings without touching the ring', () => {
    const ring = seedProgressSamples(tempDiag(50), 0);
    const next = recordProgressSample(
      ring,
      makeDiag({
        currentTemperatureC: 99,
        currentValue: 99,
        reasonCode: 'objective_progress_stale',
      }),
      QUARTER_MS,
    );
    expect(next).toBe(ring);
  });

  it('re-buckets onto a coarser grid when an upsert exceeds the cap', () => {
    let ring = new Map<number, DeferredObjectivePlanHistoryProgressSample>();
    for (let i = 0; i <= PROGRESS_SAMPLES_PER_ENTRY_CAP; i += 1) {
      ring = recordProgressSample(ring, tempDiag(20 + i * 0.1), i * QUARTER_MS);
    }
    // The insert that crossed the cap collapsed the ring onto the 30-minute
    // grid (one kept sample per pair of quarter-hour buckets) instead of
    // dropping the oldest readings.
    expect(ring.size).toBeLessThanOrEqual(PROGRESS_SAMPLES_PER_ENTRY_CAP);
    const drained = drainProgressSamples(ring);
    // Run start survives: the first coarse bucket keeps its latest reading
    // (the 0:15 observation), not a reading hours into the run.
    expect(drained[0]!.atMs).toBe(QUARTER_MS);
    // The newest reading is always retained.
    expect(drained[drained.length - 1]!.atMs).toBe(PROGRESS_SAMPLES_PER_ENTRY_CAP * QUARTER_MS);
  });
});

describe('rebucketProgressSamples', () => {
  const ringOfQuarters = (count: number): Map<number, DeferredObjectivePlanHistoryProgressSample> => {
    const ring = new Map<number, DeferredObjectivePlanHistoryProgressSample>();
    for (let i = 0; i < count; i += 1) {
      ring.set(i * QUARTER_MS, { atMs: i * QUARTER_MS, valueC: 20 + i, valuePercent: null });
    }
    return ring;
  };

  it('returns a copy unchanged when already within the cap', () => {
    const ring = ringOfQuarters(10);
    const out = rebucketProgressSamples(ring, 10);
    expect(out).not.toBe(ring);
    expect([...out.entries()]).toEqual([...ring.entries()]);
  });

  it('doubles the grid until the count fits, keeping the latest reading per coarse bucket', () => {
    // 12 quarter-hour samples against a cap of 4: 30-minute grid gives 6
    // buckets (still over), the 1-hour grid gives 3 (fits).
    const out = rebucketProgressSamples(ringOfQuarters(12), 4);
    expect(out.size).toBe(3);
    const drained = [...out.values()].sort((a, b) => a.atMs - b.atMs);
    // Each kept sample is the LATEST reading of its hour (quarters 3, 7, 11),
    // mirroring the per-cycle upsert's latest-reading-wins semantics.
    expect(drained.map((s) => s.atMs)).toEqual([3 * QUARTER_MS, 7 * QUARTER_MS, 11 * QUARTER_MS]);
    expect(drained.map((s) => s.valueC)).toEqual([23, 27, 31]);
  });

  it('is deterministic: a pure function of the sample timestamps', () => {
    const a = rebucketProgressSamples(ringOfQuarters(50), 8);
    const b = rebucketProgressSamples(ringOfQuarters(50), 8);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe('drainProgressSamples', () => {
  it('returns samples sorted ascending by atMs regardless of insertion order', () => {
    const ring = new Map<number, DeferredObjectivePlanHistoryProgressSample>([
      [2 * HOUR_MS, { atMs: 2 * HOUR_MS, valueC: 60, valuePercent: null }],
      [0, { atMs: 0, valueC: 50, valuePercent: null }],
      [QUARTER_MS, { atMs: QUARTER_MS, valueC: 52, valuePercent: null }],
    ]);
    expect(drainProgressSamples(ring).map((s) => s.atMs)).toEqual([0, QUARTER_MS, 2 * HOUR_MS]);
  });

  it('re-buckets (never truncates) as a backstop when handed an over-cap ring', () => {
    const ring = new Map<number, DeferredObjectivePlanHistoryProgressSample>();
    const count = PROGRESS_SAMPLES_PER_ENTRY_CAP + 40;
    for (let i = 0; i < count; i += 1) {
      ring.set(i * QUARTER_MS, { atMs: i * QUARTER_MS, valueC: 20 + i, valuePercent: null });
    }
    const drained = drainProgressSamples(ring);
    expect(drained.length).toBeLessThanOrEqual(PROGRESS_SAMPLES_PER_ENTRY_CAP);
    // Coarser-grid collapse preserves both ends of the run.
    expect(drained[0]!.atMs).toBe(QUARTER_MS);
    expect(drained[drained.length - 1]!.atMs).toBe((count - 1) * QUARTER_MS);
  });
});

describe('mergeRecord × stall freeze at the 15-minute cadence', () => {
  it('keeps recording post-stall samples while finalProgress stays frozen at the plateau', () => {
    const record = startRecord(tempDiag(60.9), 0, undefined);
    expect(record).not.toBeNull();
    const stalled = promoteRecordToStalled(record!, tempDiag(61.8), 3 * HOUR_MS, 'stalled');
    // Post-stall cooling tick a quarter-hour later: the sample ring is
    // deliberately NOT frozen (the coast is what the trajectory chart should
    // show) but the headline plateau values are.
    const merged = mergeRecord(stalled, tempDiag(61.5), 3 * HOUR_MS + QUARTER_MS, undefined);
    expect(merged.satisfied).toBe(true);
    expect(merged.metAtMs).toBe(3 * HOUR_MS);
    expect(merged.finalProgressC).toBeCloseTo(61.8, 5);
    const drained = drainProgressSamples(merged.progressSamples);
    expect(drained.map((s) => s.valueC)).toEqual([60.9, 61.5]);
    expect(drained.map((s) => s.atMs)).toEqual([0, 3 * HOUR_MS + QUARTER_MS]);
  });
});
