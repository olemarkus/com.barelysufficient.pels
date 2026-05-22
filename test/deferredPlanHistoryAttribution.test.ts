// Unit tests for the plan-time miss-attribution producer (Session A of the
// "Cannot finish / missed streaks don't match reality" investigation). Covers
// the classifier `resolveDeferredPlanHistoryMissAttribution` (cause priority +
// raw field passthrough) and the narrow `formatRefinedMissCause` copy that the
// history "Why" line inserts ahead of its shipped planStatus branches.
import {
  formatRefinedMissCause,
  resolveDeferredPlanHistoryMissAttribution,
} from '../packages/shared-domain/src/deferredPlanHistoryAttribution';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

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
): DeferredObjectivePlanHistoryEntry => ({
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
  usedPolicyAvoid: false,
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

  it('classifies low_confidence ahead of the delivered-vs-plan split', () => {
    // Delivered above plan (would be energy_underestimate) but the rate was
    // low-confidence — the shaky estimate undercuts the whole verdict.
    const entry = buildEntry({
      deliveredKWh: 25,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 3 }),
    });
    expect(resolveDeferredPlanHistoryMissAttribution(entry).cause).toBe('low_confidence');
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
});

describe('formatRefinedMissCause', () => {
  it('names the sample count when the estimate was still learning', () => {
    const entry = buildEntry({
      deliveredKWh: 25,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 3 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      "PELS was still learning this device's energy use (3 readings) when it planned this run.",
    );
  });

  it('singularises a single reading', () => {
    const entry = buildEntry({
      deliveredKWh: 25,
      finalPlan: buildSnapshot({ rateConfidence: 'low', acceptedSamples: 1 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      "PELS was still learning this device's energy use (1 reading) when it planned this run.",
    );
  });

  it('omits the reading count when the sample count was not recorded', () => {
    const entry = buildEntry({
      deliveredKWh: 25,
      finalPlan: buildSnapshot({ rateConfidence: 'low' }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      "PELS was still learning this device's energy use when it planned this run.",
    );
  });

  it('explains an energy underestimate when power was available', () => {
    const entry = buildEntry({
      deliveredKWh: 21,
      finalPlan: buildSnapshot({ rateConfidence: 'high', acceptedSamples: 12 }),
    });
    expect(formatRefinedMissCause(entry)).toBe(
      'Power was available, but the target needed more energy than estimated.',
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
});
