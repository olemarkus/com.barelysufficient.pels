// Unit tests for the plan-time miss-attribution producer (Session A of the
// "Cannot finish / missed streaks don't match reality" investigation). Covers
// the classifier `resolveDeferredPlanHistoryMissAttribution` (cause priority +
// raw field passthrough) and the narrow `formatRefinedMissCause` copy that the
// history "Why" line inserts ahead of its shipped planStatus branches.
import {
  formatRefinedMissCause,
  resolveDeferredPlanHistoryMissAttribution,
} from '../../packages/shared-domain/src/deferredPlanHistoryAttribution';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 16, 16, 0, 0);

const buildSnapshot = (
  overrides: Partial<DeferredObjectivePlanHistoryRevisionSnapshot> = {},
): DeferredObjectivePlanHistoryRevisionSnapshot => ({
  hours: [
    { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 10 },
    { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 10 },
  ],
  energyNeededKWh: 20,
  planStatus: 'cannot_meet',
  revisedAtMs: DEADLINE_MS - 3 * HOUR_MS,
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
  startedAtMs: DEADLINE_MS - 6 * HOUR_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 60,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 20,
  outcome: 'missed',
  metAtMs: null,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

describe('resolveDeferredPlanHistoryMissAttribution', () => {
  it('returns a null cause for non-missed outcomes', () => {
    const entry = buildEntry({ outcome: 'met', finalPlan: buildSnapshot() });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBeNull();
  });

  it('classifies unknown when no plan snapshot was recorded', () => {
    const entry = buildEntry({ originalPlan: null, finalPlan: null });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('unknown');
  });

  it('classifies budget_limited ahead of low confidence when the cap collapsed hours', () => {
    const entry = buildEntry({
      finalPlan: buildSnapshot({ dailyBudgetExhaustedBucketCount: 2, rateConfidence: 'low' }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('budget_limited');
  });

  it('lets the delivery split win over a low confidence band', () => {
    // Delivered above plan AND a low confidence band — but the band "sits at low
    // effectively forever" on thermal devices, so the concrete delivery story
    // (energy underestimate) must win rather than masking it as "still learning".
    // The device made real progress (default 50 -> 60), so no_delivery is out.
    const entry = buildEntry({
      deliveredKWh: 25,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1090 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('energy_underestimate');
  });

  it('classifies no_delivery when the device delivered almost nothing and stayed flat', () => {
    // Thermal device with 1090 accepted samples and a low band — under the old
    // classifier this read "still learning (1090 readings)". Now the flat,
    // no-delivery story wins.
    const entry = buildEntry({
      deliveredKWh: 0.02,
      startProgressC: 18.3,
      finalProgressC: 18.6,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1090 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('no_delivery');
  });

  it('classifies no_delivery for a cooling start-above-target task', () => {
    // The screenshot case: asked to heat to 40 but already at 64.7, the tank only
    // cooled to 20.1 — it delivered no heat. Directional progress (final - start)
    // is a large negative, below the deadband, so no_delivery fires.
    const entry = buildEntry({
      targetTemperatureC: 40,
      deliveredKWh: 0,
      startProgressC: 64.7,
      finalProgressC: 20.1,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1141 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('no_delivery');
  });

  it('fires no_delivery on flat progress alone when delivery was never recorded', () => {
    const entry = buildEntry({
      deliveredKWh: undefined,
      startProgressC: 18.3,
      finalProgressC: 18.5,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 50 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('no_delivery');
  });

  it('classifies no_delivery for an EV that barely charged', () => {
    const entry = buildEntry({
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      startProgressC: null,
      finalProgressC: null,
      startProgressPercent: 41,
      finalProgressPercent: 41.5,
      deliveredKWh: 0.03,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 30 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('no_delivery');
  });

  it('classifies budget_limited ahead of no_delivery', () => {
    const entry = buildEntry({
      deliveredKWh: 0,
      startProgressC: 18.3,
      finalProgressC: 18.4,
      finalPlan: buildSnapshot({ dailyBudgetExhaustedBucketCount: 2 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('budget_limited');
  });

  it('classifies low_confidence only on a genuine cold start with delivery unmeasured', () => {
    // Few accepted samples (< the confident-chip threshold) AND no recorded
    // delivery to tell a concrete story — the honest fallback is "still learning".
    const entry = buildEntry({
      deliveredKWh: undefined,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 2 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('low_confidence');
  });

  it('does not classify low_confidence on a well-sampled rate with delivery unmeasured', () => {
    // 1090 samples is no cold start, so even with delivery unmeasured the verdict
    // is honestly `unknown`, never "still learning".
    const entry = buildEntry({
      deliveredKWh: undefined,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1090 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('unknown');
  });

  it('treats a runtime-null acceptedSamples as not-cold-start (no coercion)', () => {
    // A persisted/legacy entry can carry `acceptedSamples: null` despite the
    // `number` type. `null < 4` coerces to true, so a `!== undefined` guard would
    // misfire `low_confidence`; the `typeof === 'number'` guard falls back to
    // `unknown`.
    const entry = buildEntry({
      deliveredKWh: undefined,
      finalPlan: buildSnapshot({
        rateConfidence: 'low',
        acceptedSamples: null as unknown as number,
      }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('unknown');
  });

  it('classifies energy_underestimate when delivery met/exceeded the planned floor', () => {
    const entry = buildEntry({
      deliveredKWh: 21,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
    expect(attribution.cause).toBe('energy_underestimate');
    expect(attribution.deliveredAtOrAbovePlan).toBe(true);
  });

  it('classifies capacity_shortfall when delivery fell short of the planned floor', () => {
    const entry = buildEntry({
      deliveredKWh: 12,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
    expect(attribution.cause).toBe('capacity_shortfall');
    expect(attribution.deliveredAtOrAbovePlan).toBe(false);
  });

  it('classifies unknown when delivery was never recorded on a confident plan', () => {
    const entry = buildEntry({
      deliveredKWh: undefined,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
    expect(attribution.cause).toBe('unknown');
    expect(attribution.deliveredAtOrAbovePlan).toBeNull();
  });

  it('surfaces the raw inputs the classification rested on', () => {
    const entry = buildEntry({
      deliveredKWh: 21,
      finalPlan: buildSnapshot({
        rateConfidence: 'medium',
        acceptedSamples: 7,
        planningSpeedKw: 3.4,
      }),
    });
    const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
    expect(attribution).toMatchObject({
      plannedKWh: 20,
      deliveredKWh: 21,
      planningSpeedKw: 3.4,
      rateConfidence: 'medium',
      acceptedSamples: 7,
      dailyBudgetExhaustedBucketCount: 0,
    });
  });

  it('prefers finalPlan over originalPlan for the attribution snapshot', () => {
    const entry = buildEntry({
      deliveredKWh: 21,
      originalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 2 }),
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('energy_underestimate');
  });

  it('does not label a wide-buffer high-confidence run delivering the mean as capacity_shortfall', () => {
    // Regression for the v2.8.0→main release-review `pels-runtime-reality`
    // finding: runs with a wide `k·SE` buffer persist a buffered
    // `plannedKWh` total (mean + k·SE) on the snapshot's hours, so the
    // buffered comparison would call the run a capacity miss even when
    // delivered energy met the underlying mean estimate. The snapshot uses
    // `rateConfidence: 'high'` so the low-confidence branch can't hide the
    // bug; the only thing inflating `plannedKWh` is the variance buffer.
    // Verifies both halves of the fix —
    // (a) without the mean argument the classifier still reads
    // `capacity_shortfall` (legacy behaviour, no UI regression), and
    // (b) threading `energyExpectedKWh` from the live revision flips the
    // attribution to `energy_underestimate` because the mean was met.
    const snapshot = buildSnapshot({
      // Buffered plan total = 5.0 kWh across two hours (mean 3.0 + k·SE 2.0).
      hours: [
        { startsAtMs: DEADLINE_MS - 2 * HOUR_MS, plannedKWh: 2.5 },
        { startsAtMs: DEADLINE_MS - HOUR_MS, plannedKWh: 2.5 },
      ],
      energyNeededKWh: 5.0,
      rateConfidence: 'high',
      acceptedSamples: 12,
    });
    const entry = buildEntry({ deliveredKWh: 3.2, finalPlan: snapshot });

    // (a) Legacy behaviour: buffered comparison flags capacity shortfall.
    const buffered = resolveDeferredPlanHistoryMissAttribution(entry);
    expect(buffered.cause).toBe('capacity_shortfall');
    expect(buffered.deliveredAtOrAbovePlan).toBe(false);

    // (b) Mean-aware comparison: delivered 3.2 ≥ mean 3.0 × 0.95.
    const meanAware = resolveDeferredPlanHistoryMissAttribution(entry, 3.0);
    expect(meanAware.cause).toBe('energy_underestimate');
    expect(meanAware.deliveredAtOrAbovePlan).toBe(true);
    // The reported `plannedKWh` still surfaces the buffered total — the fix
    // only shifts the comparison basis, not the raw input passthrough.
    expect(meanAware.plannedKWh).toBeCloseTo(5.0);
  });

  it('falls back to the buffered comparison when energyExpectedKWh is zero or invalid', () => {
    // Defensive: a non-positive / NaN / undefined mean must not silently
    // disable the floor comparison. The classifier should reuse the buffered
    // `plannedKWh` instead — matching the legacy code path so UI renders of
    // historical entries (which always pass null) stay deterministic.
    const entry = buildEntry({
      deliveredKWh: 12,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry, 0).cause).toBe('capacity_shortfall');
    expect(resolveDeferredPlanHistoryMissAttribution(entry, Number.NaN).cause).toBe('capacity_shortfall');
    expect(resolveDeferredPlanHistoryMissAttribution(entry, null).cause).toBe('capacity_shortfall');
  });
});

describe('formatRefinedMissCause', () => {
  it('says still learning, with no reading count, on a genuine cold start', () => {
    const entry = buildEntry({
      deliveredKWh: undefined,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 2 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      "Still learning this device's energy use.",
    );
  });

  it('explains no heat delivered for a temperature task', () => {
    const entry = buildEntry({
      deliveredKWh: 0.01,
      startProgressC: 18.3,
      finalProgressC: 18.6,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1141 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      'Delivered almost no heat before the deadline.',
    );
  });

  it('explains no charge delivered for an EV task', () => {
    const entry = buildEntry({
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      startProgressC: null,
      finalProgressC: null,
      startProgressPercent: 41,
      finalProgressPercent: 41.4,
      deliveredKWh: 0.02,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 30 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      'Delivered almost no charge before the deadline.',
    );
  });

  it('explains an energy underestimate when power was available', () => {
    const entry = buildEntry({
      deliveredKWh: 21,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      'Target needed more energy than estimated.',
    );
  });

  it('returns null for causes the shipped planStatus copy already handles', () => {
    const budgetEntry = buildEntry({
      finalPlan: buildSnapshot({ dailyBudgetExhaustedBucketCount: 2 }),
    });
    const capacityEntry = buildEntry({
      deliveredKWh: 12,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    expect(formatRefinedMissCause(budgetEntry)).toBeNull();
    expect(formatRefinedMissCause(capacityEntry)).toBeNull();
  });

  it('never emits a multi-digit reading count, even on a well-sampled low band', () => {
    // Guard for the original defect: a thermal device with 1090 accepted samples
    // and a permanently-low band used to render "still learning (1090 readings)".
    // It must now never produce that self-contradictory copy under any delivery
    // shape.
    const shapes: Partial<DeferredObjectivePlanHistoryEntry>[] = [
      { deliveredKWh: 25 }, // delivered above floor -> energy_underestimate
      { deliveredKWh: 12 }, // delivered below floor -> capacity_shortfall (null copy)
      { deliveredKWh: undefined }, // unmeasured -> unknown (null copy)
      { deliveredKWh: 0.01, startProgressC: 18.3, finalProgressC: 18.6 }, // no_delivery
    ];
    for (const shape of shapes) {
      const entry = buildEntry({
        ...shape,
        finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1090 }),
      });
      const copy = formatRefinedMissCause(entry);
      expect(copy ?? '').not.toMatch(/\d{4} readings/);
      expect(copy ?? '').not.toContain('(1090 readings)');
      expect(copy ?? '').not.toContain('readings');
    }
  });
});
