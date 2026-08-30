import { resolveCurrentHourClaim } from '../../lib/objectives/deferredObjectives/currentHourClaim';
import { resolveFloorShortfallCause } from '../../lib/objectives/deferredObjectives/floorShortfallCause';
import {
  resolvedTrajectoryStatus,
  type DeferredObjectiveDiagnostic,
} from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  buildDeferredObjectiveDiagnostics as buildDeferredObjectiveDiagnosticsRaw,
  buildDeferredObjectivePolicyHorizon as buildDeferredObjectivePolicyHorizonRaw,
  createEmptyDeferredObjectiveSettings,
  ELIGIBILITY_ABANDON_GRACE_MS,
  normalizeDeferredObjectiveSettings,
  PriorityAllocationTracker,
  resolveDeferredObjectiveDeadline,
} from '../../lib/objectives/deferredObjectives';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import type {
  DeferredObjectivePlannedBucket,
} from '../../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDebugPayload } from '../../lib/objectives/deferredObjectives/diagnosticDebugPayload';
import {
  emitDeferredObjectiveDiagnostics,
  type DeferredObjectiveUnknownAnnounce,
} from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import {
  type PlanInputDevice,
  type TemperatureDiscriminantProbe,
  withBinaryDiscriminant,
  withTemperatureDiscriminant,
} from '../../lib/plan/planTypes';
import { type FixtureBoostFields, withFixtureResidualKw, withMaterializedEvPlugState } from '../utils/planTestUtils';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanHistoryV5 } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { buildObjectiveSignature } from '../../lib/objectives/deferredObjectives/activePlanSignature';
import { buildPriorityReservations } from '../../lib/objectives/deferredObjectives/priorityAllocation';
import { buildHoursFromHorizonPlan } from '../../lib/objectives/deferredObjectives/activePlanSchedule';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 17, 0, 0);

// Materialize the flat EV plug-state sub-fields from the readable
// `evChargingState` (mirroring the production producer `toPlanDevice`) so these
// objective-diagnostics fixtures exercise the materialized path the planner
// actually consumes, not the raw snapshot-fallback arm of the dual-read.
// Every diagnostic the bridge emits must carry the claim its OWN reported cause
// implies — the cause the recorder will persist and the frozen read will replay.
// Bridge overlays that rewrite `reasonCode` after the plan is built are what can
// break it (`resolveHigherPriorityContentionStatus`), so this is asserted wherever
// an overlay is in play rather than only where the values happen to differ today.
const expectClaimMatchesReportedCause = (diag: DeferredObjectiveDiagnostic | undefined): void => {
  const plan = diag?.horizonPlan;
  expect(plan).toBeDefined();
  expect(plan?.currentHourClaim).toBe(resolveCurrentHourClaim({
    currentBucketBookedKWh: plan?.currentBucket?.plannedUsefulEnergyKWh ?? null,
    priceDeferralEligible: plan?.priceDeferralEligible === true,
    coldStartReleaseEligible: plan?.coldStartReleaseEligible === true,
    floorShortfallCause: resolveFloorShortfallCause(diag?.reasonCode),
  }));
};

const buildDevice = (
  overrides: Partial<PlanInputDevice> & FixtureBoostFields & { evChargingState?: string } = {},
): PlanInputDevice => withMaterializedEvPlugState(withFixtureResidualKw({
  id: 'ev-1',
  expectedPowerKw: 1,
  name: 'Driveway EV',
  targets: [],
  binaryControl: { on: false },
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in_paused',
  stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: NOW_MS }),
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1000 },
      { id: 'high', planningPowerW: 2000 },
    ],
  },
  ...overrides,
  controllable: overrides.controllable ?? true,
  available: overrides.available ?? true,
})) as PlanInputDevice;

const buildTemperatureDevice = (
  overrides: Partial<PlanInputDevice> & TemperatureDiscriminantProbe = {},
): PlanInputDevice => withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({
  id: 'heater-1',
  expectedPowerKw: 1,
  name: 'Connected 300',
  targets: [{ id: 'target_temperature', value: 55, unit: 'C', min: 0, max: 95, step: 0.5 }],
  binaryControl: { on: false },
  deviceType: 'temperature' as const,
  controlModel: 'stepped_load' as const,
  controlCapabilityId: 'onoff' as const,
  currentTemperature: 55,
  lastFreshDataMs: NOW_MS,
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'heat', planningPowerW: 3000 },
    ],
  },
  ...overrides,
  controllable: overrides.controllable ?? true,
  available: overrides.available ?? true,
}))) as PlanInputDevice;

const resolveDeadlineAtMsFor = (deadlineLocalTime: string, nowMs: number = NOW_MS): number => {
  const resolution = resolveDeferredObjectiveDeadline({
    nowMs,
    timeZone: 'UTC',
    deadlineLocalTime,
  });
  if (resolution.deadlineAtMs === null) throw new Error('Failed to resolve test deadline');
  return resolution.deadlineAtMs;
};

const buildSettings = (overrides: Record<string, unknown> = {}) => {
  const { deadlineLocalTime, ...rest } = overrides as { deadlineLocalTime?: string };
  const deadlineAtMs = resolveDeadlineAtMsFor(deadlineLocalTime ?? '21:00');
  return {
    version: 1,
    objectivesByDeviceId: {
      'ev-1': {
        enabled: true,
        kind: 'ev_soc',
        enforcement: 'soft',
        targetPercent: 60,
        deadlineAtMs,
        ...rest,
      },
    },
  };
};

const buildTemperatureSettings = (overrides: Record<string, unknown> = {}) => {
  const { deadlineLocalTime, ...rest } = overrides as { deadlineLocalTime?: string };
  const deadlineAtMs = resolveDeadlineAtMsFor(deadlineLocalTime ?? '21:00');
  return {
    version: 1,
    objectivesByDeviceId: {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 65,
        deadlineAtMs,
        ...rest,
      },
    },
  };
};

const buildPowerTracker = (overrides: Partial<PowerTrackerState> = {}): PowerTrackerState => ({
  objectiveProfiles: {
    'ev-1': {
      kind: 'ev_soc',
      updatedAtMs: NOW_MS,
      lastSample: { observedAtMs: NOW_MS, value: 40, unit: 'percent' },
      kwhPerUnit: {
        sampleCount: 4,
        mean: 0.2,
        m2: 0,
        min: 0.2,
        max: 0.2,
        confidence: 'medium',
        lastUpdatedMs: NOW_MS,
      },
      acceptedSamples: 4,
      rejectedSamples: 0,
    },
  },
  ...overrides,
});

const buildHistoryRecorder = (): {
  recorder: DeferredObjectivePlanHistoryRecorder;
  saved: () => DeferredObjectivePlanHistoryV5 | null;
} => {
  let saved: DeferredObjectivePlanHistoryV5 | null = null;
  return {
    recorder: new DeferredObjectivePlanHistoryRecorder({
      load: () => ({ snapshot: { version: 5, entries: [] }, persistenceSafe: true }),
      save: (next) => { saved = next; return true; },
    }),
    saved: () => saved,
  };
};

const buildTemperaturePowerTracker = (overrides: Partial<PowerTrackerState> = {}): PowerTrackerState => ({
  objectiveProfiles: {
    'heater-1': {
      kind: 'temperature',
      updatedAtMs: NOW_MS,
      lastSample: { observedAtMs: NOW_MS, value: 55, unit: 'degree_c' },
      kwhPerUnit: {
        sampleCount: 6,
        mean: 0.8,
        m2: 0,
        min: 0.7,
        max: 0.9,
        confidence: 'high',
        lastUpdatedMs: NOW_MS,
      },
      acceptedSamples: 6,
      rejectedSamples: 0,
    },
  },
  ...overrides,
});

const buildSnapshot = (params: {
  nowMs?: number;
  includeTomorrow?: boolean;
  includePriceFactor?: boolean;
  prices?: number[];
  plannedUncontrolledKWh?: number[];
  plannedGrossUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  allowedCumKWh?: number[];
} = {}): DailyBudgetUiPayload => {
  const nowMs = params.nowMs ?? NOW_MS;
  const today = buildDay({
    dateKey: '2026-01-01',
    startMs: Date.UTC(2026, 0, 1, 0),
    currentBucketIndex: new Date(nowMs).getUTCHours(),
    includePriceFactor: params.includePriceFactor,
    prices: params.prices,
    plannedUncontrolledKWh: params.plannedUncontrolledKWh,
    plannedGrossUncontrolledKWh: params.plannedGrossUncontrolledKWh,
    plannedControlledKWh: params.plannedControlledKWh,
    allowedCumKWh: params.allowedCumKWh,
  });
  const days: DailyBudgetUiPayload['days'] = { [today.dateKey]: today };
  if (params.includeTomorrow) {
    const tomorrow = buildDay({
      dateKey: '2026-01-02',
      startMs: Date.UTC(2026, 0, 2, 0),
      currentBucketIndex: 0,
      includePriceFactor: params.includePriceFactor,
      prices: params.prices,
      plannedUncontrolledKWh: params.plannedUncontrolledKWh,
      plannedGrossUncontrolledKWh: params.plannedGrossUncontrolledKWh,
      plannedControlledKWh: params.plannedControlledKWh,
      allowedCumKWh: params.allowedCumKWh,
    });
    days[tomorrow.dateKey] = tomorrow;
  }
  return {
    days,
    todayKey: today.dateKey,
    tomorrowKey: params.includeTomorrow ? '2026-01-02' : null,
  };
};

const buildDay = (params: {
  dateKey: string;
  startMs: number;
  currentBucketIndex: number;
  includePriceFactor?: boolean;
  prices?: number[];
  plannedUncontrolledKWh?: number[];
  plannedGrossUncontrolledKWh?: number[];
  plannedControlledKWh?: number[];
  allowedCumKWh?: number[];
}): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: 24 }, (_, index) => new Date(params.startMs + index * HOUR_MS).toISOString());
  const prices = params.prices ?? Array.from({ length: 24 }, (_, index) => index);
  return {
    dateKey: params.dateKey,
    timeZone: 'UTC',
    nowUtc: new Date(NOW_MS).toISOString(),
    dayStartUtc: new Date(params.startMs).toISOString(),
    currentBucketIndex: params.currentBucketIndex,
    budget: {
      enabled: true,
      dailyBudgetKWh: 20,
      priceShapingEnabled: true,
    },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 0,
      remainingKWh: 20,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: true,
    },
    // `plannedControlledKWh` and `plannedUncontrolledKWh` stay CONDITIONAL. The
    // policy horizon reads the hour's own controlled share for the daily-budget
    // cap and the uncontrolled forecast for physical headroom, keying both off
    // field presence — so the legacy-snapshot fixtures (which omit them) must NOT
    // carry a fabricated zero array; that would introduce caps the legacy path
    // never had. The current contract marks the fields required, so cast the
    // literal at this fixture boundary.
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, index) => `${String(index).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: Array.from({ length: 24 }, () => 1),
      actualKWh: Array.from({ length: 24 }, () => 0),
      actualControlledKWh: Array.from({ length: 24 }, () => 0),
      actualUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      allowedCumKWh: params.allowedCumKWh ?? Array.from({ length: 24 }, (_, index) => index + 1),
      price: prices,
      ...(params.plannedControlledKWh ? { plannedControlledKWh: params.plannedControlledKWh } : {}),
      ...(params.plannedUncontrolledKWh ? { plannedUncontrolledKWh: params.plannedUncontrolledKWh } : {}),
      ...(params.plannedGrossUncontrolledKWh
        ? { plannedGrossUncontrolledKWh: params.plannedGrossUncontrolledKWh }
        : {}),
      ...(params.includePriceFactor === false
        ? {}
        : { priceFactor: prices.map((price) => (price <= 10 ? 1.2 : 0.8)) }),
    } as DailyBudgetDayPayload['buckets'],
  };
};

// Derive a price-layer `CombinedPricesV2` from a daily-budget snapshot so the
// allocation horizon (which now reads the price layer directly) sees EXACTLY the
// same per-hour prices the snapshot carries. For these UTC (whole-hour-offset)
// fixtures each snapshot day-bucket `startUtc` is already hour-aligned, so the
// derived combined-prices hours map one-to-one onto the snapshot's price buckets.
const combinedFromSnapshot = (snapshot: DailyBudgetUiPayload | null): CombinedPricesV2 | null => {
  if (!snapshot) return null;
  const days: CombinedPricesV2['days'] = {};
  for (const [dateKey, day] of Object.entries(snapshot.days)) {
    const hours: CombinedPriceEntry[] = day.buckets.startUtc.map((startsAt, index) => ({
      startsAt,
      // `buildDay` always populates a numeric `price` array (optional on the type).
      total: day.buckets.price![index]!,
      isCheap: false,
      isExpensive: false,
    }));
    days[dateKey] = { hours };
  }
  return {
    version: 2,
    days,
    avgPrice: 0,
    lowThreshold: 0,
    highThreshold: 0,
    priceScheme: 'norway',
    priceUnit: 'øre/kWh',
  };
};

// Wrapper: inject the price-layer `combinedPrices` derived from the same snapshot
// the test already supplies, so existing budget-overlay assertions stay intact.
const buildDeferredObjectiveDiagnostics = (
  params: Omit<Parameters<typeof buildDeferredObjectiveDiagnosticsRaw>[0], 'buildPriceHorizon'>,
): ReturnType<typeof buildDeferredObjectiveDiagnosticsRaw> => {
  const combined = combinedFromSnapshot(params.dailyBudgetSnapshot);
  return buildDeferredObjectiveDiagnosticsRaw({
    ...params,
    buildPriceHorizon: (nowMs, deadlineAtMs) => buildPriceHorizonFromCombined(combined, nowMs, deadlineAtMs),
  });
};

// Wrapper: inject the `priceHorizon` derived from the same snapshot the test
// supplies, sourced through the production builder so the horizon entries match
// what the live cycle would derive from the price layer.
const buildDeferredObjectivePolicyHorizon = (
  params: Omit<Parameters<typeof buildDeferredObjectivePolicyHorizonRaw>[0], 'priceHorizon'>,
): ReturnType<typeof buildDeferredObjectivePolicyHorizonRaw> => buildDeferredObjectivePolicyHorizonRaw({
  ...params,
  priceHorizon: buildPriceHorizonFromCombined(
    combinedFromSnapshot(params.dailyBudgetSnapshot),
    params.nowMs,
    params.deadlineAtMs,
  ),
});

const sumReserveAllocation = (plannedBuckets: readonly DeferredObjectivePlannedBucket[]): number => (
  plannedBuckets.reduce((sum, bucket) => sum + (bucket.reserve ? bucket.plannedUsefulEnergyKWh : 0), 0)
);

const plannedBySourceBucket = (
  plannedBuckets: readonly DeferredObjectivePlannedBucket[],
  sourceBucketId: string,
): number => (
  plannedBuckets
    .filter((bucket) => bucket.sourceBucketId === sourceBucketId)
    .reduce((sum, bucket) => sum + bucket.plannedUsefulEnergyKWh, 0)
);

describe('deferred objective settings', () => {
  const evDeadlineAtMs = resolveDeadlineAtMsFor('07:30');
  const tempDeadlineAtMs = resolveDeadlineAtMsFor('08:00');
  const evPadDeadlineAtMs = resolveDeadlineAtMsFor('08:15');

  it('keeps valid enabled EV SoC objectives and drops invalid entries', () => {
    expect(normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-1': {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'hard',
          targetPercent: 80,
          deadlineAtMs: evDeadlineAtMs,
        },
        bad: {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'hard',
          targetPercent: 120,
          deadlineAtMs: evDeadlineAtMs,
        },
      },
    })).toEqual({
      version: 1,
      objectivesByDeviceId: {
        'ev-1': {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'hard',
          targetPercent: 80,
          deadlineAtMs: evDeadlineAtMs,
        },
      },
    });
  });

  it('stores whitespace-padded device ids under their trimmed key', () => {
    expect(normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        ' ev-1 ': {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'soft',
          targetPercent: 70,
          deadlineAtMs: evPadDeadlineAtMs,
        },
      },
    })).toEqual({
      version: 1,
      objectivesByDeviceId: {
        'ev-1': {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'soft',
          targetPercent: 70,
          deadlineAtMs: evPadDeadlineAtMs,
        },
      },
    });
  });

  it('keeps valid temperature objectives', () => {
    expect(normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: tempDeadlineAtMs,
        },
      },
    })).toEqual({
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: tempDeadlineAtMs,
        },
      },
    });
  });

  it('drops hard temperature objectives until hard thermal semantics exist', () => {
    expect(normalizeDeferredObjectiveSettings(buildTemperatureSettings({ enforcement: 'hard' }))).toEqual({
      version: 1,
      objectivesByDeviceId: {},
    });
  });

  it('returns an empty versioned settings object for unsupported payloads', () => {
    expect(normalizeDeferredObjectiveSettings({ version: 1 })).toEqual(createEmptyDeferredObjectiveSettings());
  });
});

describe('resolveDeferredObjectiveDeadline', () => {
  it('chooses the next repeated local time during DST fall-back', () => {
    const deadline = resolveDeferredObjectiveDeadline({
      nowMs: Date.UTC(2026, 10, 1, 6, 15, 0),
      timeZone: 'America/New_York',
      deadlineLocalTime: '01:30',
    });

    expect(deadline).toEqual({
      deadlineAtMs: Date.UTC(2026, 10, 1, 6, 30, 0),
      localDateKey: '2026-11-01',
      rollsToNextDay: false,
    });
  });

  it('selects the earliest valid UTC candidate for an ambiguous fall-back hour', () => {
    // Europe/Oslo fall-back: last Sunday of October 2026 = 2026-10-25. At local
    // 03:00 CEST the wall clock jumps back to 02:00 CET, so local 02:30 occurs
    // twice on that day:
    //   - First  02:30 CEST (UTC+2) = 2026-10-25 00:30 UTC
    //   - Second 02:30 CET  (UTC+1) = 2026-10-25 01:30 UTC
    // We pick nowMs = 2026-10-24 23:00 UTC, which is Oslo-local 2026-10-25
    // 01:00 CEST (still on the fall-back day, before either candidate). With
    // both 02:30 candidates strictly in the future, the contract this test
    // pins is: resolveDeferredObjectiveDeadline returns the EARLIEST valid
    // UTC candidate (00:30Z), not the later one (01:30Z). If this assertion
    // ever flips to the later candidate, the production fall-back policy has
    // changed and the change should be intentional — not an accidental
    // sort/filter regression in resolveAllLocalDateTimeMs.
    const deadline = resolveDeferredObjectiveDeadline({
      nowMs: Date.UTC(2026, 9, 24, 23, 0, 0),
      timeZone: 'Europe/Oslo',
      deadlineLocalTime: '02:30',
    });

    expect(deadline).toEqual({
      deadlineAtMs: Date.UTC(2026, 9, 25, 0, 30, 0),
      localDateKey: '2026-10-25',
      rollsToNextDay: false,
    });
  });
});

describe('buildDeferredObjectivePolicyHorizon', () => {
  it('carries the raw per-bucket price through to the horizon buckets', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, (_, index) => (index === 18 ? 100 : 10)),
      }),
    });

    expect(result.reasonCode).toBeNull();
    // The raw price is the sole price signal the allocator orders on; the
    // expensive hour carries its dear price unchanged, the rest the cheap one.
    const prices = result.buckets.map((bucket) => bucket.price);
    expect(prices).toContain(100);
    expect(prices).toContain(10);
  });

  it("sets per-bucket maxUsefulEnergyKWh from the hour's own controlled share", () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedControlledKWh: Array.from({ length: 24 }, () => 2.5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
    });
    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBeCloseTo(2.5);
    }
  });

  it('caps a bucket at its own share even when the cumulative allowance has plateaued', () => {
    // The regression this whole change exists for. `allowedCumKWh` plateaus at the
    // 20 kWh day total from index 9 on — the soft budget's ordinary shape once a
    // day has run hot, because an hour's overspend must not claw back later hours.
    // Every bucket in the horizon still holds a real 0.75 kWh share, and each must
    // be offered it. Differencing the plateaued cumulative used to return 0 here
    // and silently unbook the entire tail of the day.
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20)),
        plannedControlledKWh: Array.from({ length: 24 }, () => 0.75),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.25),
      }),
    });
    expect(result.reasonCode).toBeNull();
    expect(result.buckets.length).toBeGreaterThan(0);
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBeCloseTo(0.75);
    }
  });

  it("caps at zero when the hour's controlled share is zero (background swamps the slice)", () => {
    // The producer already floors the share at zero (`buildPlanBreakdown`), so a
    // background-swamped hour arrives as a plain 0 rather than a negative to clamp.
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedControlledKWh: Array.from({ length: 24 }, () => 0),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 5),
      }),
    });
    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBe(0);
    }
  });

  it('treats a NEGATIVE controlled share as unavailable, not as a zero cap', () => {
    // Negative energy is malformed, not a valid "no room this hour" answer.
    // Reading it as a 0 cap would make the hour unbookable on junk data — the
    // same silent unbooking this whole change fixes, arriving from the other
    // direction. Resolve to "no daily-budget cap" and let the hard cap bind.
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedControlledKWh: Array.from({ length: 24 }, () => -1),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
    });
    expect(result.reasonCode).toBeNull();
    expect(result.buckets.length).toBeGreaterThan(0);
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBeUndefined();
    }
  });

  it('omits the per-bucket cap when the controlled share is missing (legacy snapshot)', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot(),
    });
    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBeUndefined();
    }
  });

  it('lifts the per-bucket cap entirely when exempt from budget, even on an exhausted budget', () => {
    // Same budget-exhausted plateau as the exhaustion test (caps collapse to 0), but with
    // exemptFromBudget the daily-budget per-bucket cap is removed so the device can plan
    // against step capacity. The physical hard cap stays enforced downstream.
    const snapshot = {
      plannedControlledKWh: Array.from({ length: 24 }, () => 0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
    };
    const capped = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot(snapshot),
    });
    const exempt = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot(snapshot),
      exemptFromBudget: true,
    });
    expect(capped.buckets.length).toBeGreaterThan(0);
    expect(capped.buckets.every((bucket) => bucket.maxUsefulEnergyKWh === 0)).toBe(true);
    // Exempt: the per-bucket cap is omitted entirely (allocation falls back to step capacity).
    expect(exempt.buckets.every((bucket) => bucket.maxUsefulEnergyKWh === undefined)).toBe(true);
  });

  it('deducts higher-priority physical and energy reservations from the matching hour', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedControlledKWh: Array.from({ length: 24 }, () => 3.5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
      hardCapKw: 10,
      higherPriorityReservations: [{
        deviceId: 'higher-device',
        topologyKey: 'hour-0',
        startsAtMs: NOW_MS,
        admissionPowerKw: 3,
        plannedKWh: 2,
        exemptFromBudget: false,
        energySegments: [{ startMs: NOW_MS, endMs: NOW_MS + HOUR_MS, plannedKWh: 2 }],
      }],
    });
    expect(result.reasonCode).toBeNull();
    expect(result.buckets[0]?.reservedHeadroomKw).toBeCloseTo(6.5);
    // Base hourly budget stays unmodified; the allocator subtracts the exact
    // overlapping 2 kWh segment after any current/deadline proration.
    expect(result.buckets[0]?.maxUsefulEnergyKWh).toBeCloseTo(3.5);
    expect(result.buckets[0]?.higherPriorityEnergyReservations).toHaveLength(1);
    expect(result.buckets[1]?.reservedHeadroomKw).toBeCloseTo(9.5);
    expect(result.buckets[1]?.maxUsefulEnergyKWh).toBeCloseTo(3.5);
  });

  it('keeps different higher-priority physical steps exact within one source hour', () => {
    const splitMs = NOW_MS + HOUR_MS / 2;
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 2 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => (index + 1) * 10),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
      hardCapKw: 10,
      higherPriorityReservations: [
        {
          deviceId: 'higher-device',
          topologyKey: 'first-half',
          startsAtMs: NOW_MS,
          admissionPowerKw: 3,
          plannedKWh: 1.5,
          exemptFromBudget: false,
          energySegments: [{ startMs: NOW_MS, endMs: splitMs, plannedKWh: 1.5 }],
        },
        {
          deviceId: 'higher-device',
          topologyKey: 'second-half',
          startsAtMs: NOW_MS,
          admissionPowerKw: 1,
          plannedKWh: 0.5,
          exemptFromBudget: false,
          energySegments: [{ startMs: splitMs, endMs: NOW_MS + HOUR_MS, plannedKWh: 0.5 }],
        },
      ],
    });

    expect(result.reasonCode).toBeNull();
    expect(result.horizonBucketCount).toBe(2);
    expect(result.buckets.slice(0, 2).map((bucket) => ({
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      sourceBucketId: bucket.sourceBucketId,
      reservedHeadroomKw: bucket.reservedHeadroomKw,
    }))).toEqual([
      {
        startMs: NOW_MS,
        endMs: splitMs,
        sourceBucketId: new Date(NOW_MS).toISOString(),
        reservedHeadroomKw: 7,
      },
      {
        startMs: splitMs,
        endMs: NOW_MS + HOUR_MS,
        sourceBucketId: new Date(NOW_MS).toISOString(),
        reservedHeadroomKw: 9,
      },
    ]);
  });

  it('matches higher reservations to fractional-offset source buckets by overlap', () => {
    const sourceStartMs = NOW_MS - 30 * 60 * 1000;
    const nowMs = NOW_MS + 5 * 60 * 1000;
    const result = buildDeferredObjectivePolicyHorizonRaw({
      nowMs,
      deadlineAtMs: sourceStartMs + 2 * HOUR_MS,
      priceOptimizationEnabled: true,
      priceHorizon: [
        { startMs: sourceStartMs, price: 5 },
        { startMs: sourceStartMs + HOUR_MS, price: 5 },
      ],
      dailyBudgetSnapshot: null,
      hardCapKw: 10,
      higherPriorityReservations: [{
        deviceId: 'higher-device',
        topologyKey: 'fractional-hour-0',
        startsAtMs: NOW_MS,
        admissionPowerKw: 3,
        plannedKWh: 1,
        exemptFromBudget: false,
        energySegments: [{
          startMs: nowMs,
          endMs: sourceStartMs + HOUR_MS,
          plannedKWh: 1,
        }],
      }],
    });

    expect(result.reasonCode).toBeNull();
    expect(result.buckets[0]).toMatchObject({
      startMs: sourceStartMs,
      endMs: nowMs,
      reservedHeadroomKw: 10,
    });
    expect(result.buckets[0]?.higherPriorityEnergyReservations).toBeUndefined();
    expect(result.buckets[1]).toMatchObject({
      startMs: nowMs,
      endMs: sourceStartMs + HOUR_MS,
      reservedHeadroomKw: 7,
    });
    expect(result.buckets[1]?.higherPriorityEnergyReservations).toHaveLength(1);
    expect(result.buckets[2]?.reservedHeadroomKw).toBe(10);
    expect(result.buckets[2]?.higherPriorityEnergyReservations).toBeUndefined();
  });

  it("uses gross background for reservedHeadroomKw and the hour's share for the daily-budget cap", () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedControlledKWh: Array.from({ length: 24 }, () => 1.5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
        plannedGrossUncontrolledKWh: Array.from({ length: 24 }, () => 2.5),
      }),
      hardCapKw: 5,
    });

    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBeCloseTo(1.5);
      expect(bucket.reservedHeadroomKw).toBeCloseTo(2.5);
    }
  });

  it('does not let negative net-background fallback raise reservedHeadroomKw above the hard cap', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => -1),
      }),
      hardCapKw: 5,
    });

    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.reservedHeadroomKw).toBeCloseTo(5);
    }
  });

});

describe('PriorityAllocationTracker', () => {
  it('keeps a missing device reservation-eligible during the SDK grace window', () => {
    const tracker = new PriorityAllocationTracker();
    const high = buildDevice({ id: 'high', priority: 1 });
    const low = buildDevice({ id: 'low', priority: 2 });
    tracker.observe({ devices: [high, low], nowMs: NOW_MS });

    tracker.observe({ devices: [low], nowMs: NOW_MS + 30_000 });
    expect(tracker.shouldReserveMissingDevice({
      deviceId: 'high',
      nowMs: NOW_MS + 30_000,
      hasPersistedCommitment: false,
    })).toBe(true);

    tracker.observe({ devices: [low], nowMs: NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS });
    expect(tracker.shouldReserveMissingDevice({
      deviceId: 'high',
      nowMs: NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS,
      hasPersistedCommitment: false,
    })).toBe(false);
  });

  it('drops a relocated device IMMEDIATELY — membership is authoritative, no abandon grace', () => {
    // Sub-home membership is user-configured state (a pin / zone assignment),
    // not a flaky SDK read, so the grace window above must NOT apply to it: a
    // task whose device moved to a separate-meter sub-home has to stop holding
    // a share of MAIN's headroom on the very next cycle, not up to an hour
    // later. Pins the difference between the two reasons a device can vanish
    // from `params.devices`.
    const tracker = new PriorityAllocationTracker();
    const relocated = buildDevice({ id: 'relocated', priority: 1 });
    const stays = buildDevice({ id: 'stays', priority: 1 });
    tracker.observe({ devices: [relocated, stays], nowMs: NOW_MS });

    // Seconds later the device is pinned into a sub-home. It leaves
    // `params.devices` for the same reason an SDK miss would, but must be
    // treated differently.
    tracker.observe({
      devices: [stays],
      nowMs: NOW_MS + 30_000,
      isDeviceExcluded: (deviceId) => deviceId === 'relocated',
    });

    expect(tracker.shouldReserveMissingDevice({
      deviceId: 'relocated',
      nowMs: NOW_MS + 30_000,
      hasPersistedCommitment: false,
    })).toBe(false);
    // A device that merely went missing in the same cycle still gets its grace.
    tracker.observe({ devices: [], nowMs: NOW_MS + 60_000 });
    expect(tracker.shouldReserveMissingDevice({
      deviceId: 'stays',
      nowMs: NOW_MS + 60_000,
      hasPersistedCommitment: false,
    })).toBe(true);
  });
});

describe('buildDeferredObjectiveDiagnostics', () => {
  it('allocates smart tasks in priority order and marks residual contention as at risk', () => {
    const deadlineAtMs = NOW_MS + 5 * HOUR_MS;
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-1': { ...buildSettings().objectivesByDeviceId['ev-1'], deadlineAtMs },
        'ev-2': { ...buildSettings().objectivesByDeviceId['ev-1'], deadlineAtMs },
      },
    });
    const profile = buildPowerTracker().objectiveProfiles?.['ev-1'];
    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({ priority: 1 }), buildDevice({ id: 'ev-2', name: 'Second EV', priority: 2 })],
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'ev-1': profile!, 'ev-2': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => (
          index < 17 ? 0 : (index - 16) * 2
        )),
      }),
      priceOptimizationEnabled: true,
      hardCapKw: 1.5,
    });
    const high = diagnostics.find((diagnostic) => diagnostic.deviceId === 'ev-1');
    const low = diagnostics.find((diagnostic) => diagnostic.deviceId === 'ev-2');
    const highHours = new Set(
      high?.horizonPlan?.plannedBuckets
        .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
        .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS),
    );
    const lowHours = low?.horizonPlan?.plannedBuckets
      .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
      .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS) ?? [];

    expect(high && resolvedTrajectoryStatus(high)).toBe('on_track');
    expect(low).toMatchObject({
      trajectory: { kind: 'resolved', status: 'at_risk' },
      reasonCode: 'limited_by_higher_priority_task',
      replaceCommitment: true,
    });
    expect(lowHours.every((hour) => !highHours.has(hour))).toBe(true);

    // The contention overlay rewrites `statusDetail` AFTER the plan resolved its
    // claim, and the recorder derives the persisted `floorShortfallCause` from the
    // rewritten `reasonCode`. So the claim has to be re-resolved with it: inheriting
    // the pre-override one splits the fresh path from the frozen replay of the very
    // revision this cycle persists, and the device would be stood down at the `:58`
    // settle and restored mid-hour, once an hour, for as long as contention lasts.
    expectClaimMatchesReportedCause(low);
  });

  it('allows lower-priority tasks to share hours when both admission powers fit', () => {
    const deadlineAtMs = NOW_MS + 5 * HOUR_MS;
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-1': { ...buildSettings().objectivesByDeviceId['ev-1'], deadlineAtMs },
        'ev-2': { ...buildSettings().objectivesByDeviceId['ev-1'], deadlineAtMs },
      },
    });
    const profile = buildPowerTracker().objectiveProfiles?.['ev-1'];
    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({ priority: 1 }), buildDevice({ id: 'ev-2', name: 'Second EV', priority: 2 })],
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'ev-1': profile!, 'ev-2': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => (
          index < 17 ? 0 : (index - 16) * 2
        )),
      }),
      priceOptimizationEnabled: true,
      hardCapKw: 2.1,
    });
    const low = diagnostics.find((diagnostic) => diagnostic.deviceId === 'ev-2');
    expect(low && resolvedTrajectoryStatus(low)).toBe('on_track');
    expect(low?.horizonPlan?.plannedUsefulEnergyKWh).toBeCloseTo(4);
  });

  it('coordinates a settled lower task when a pending higher task bootstraps its first claim', () => {
    const deadlineAtMs = NOW_MS + 5 * HOUR_MS;
    const objective = { ...buildSettings().objectivesByDeviceId['ev-1'], deadlineAtMs };
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: { 'ev-1': objective, 'ev-2': objective },
    });
    const highPending = buildDevice({ priority: 1, evChargingState: 'plugged_out' });
    const highReady = buildDevice({ priority: 1 });
    const lowDevice = buildDevice({ id: 'ev-2', name: 'Second EV', priority: 2 });
    const profile = buildPowerTracker().objectiveProfiles?.['ev-1'];
    const common = {
      nowMs: NOW_MS,
      timeZone: 'UTC',
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'ev-1': profile!, 'ev-2': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
      priceOptimizationEnabled: true,
      hardCapKw: 1.5,
    };
    const first = buildDeferredObjectiveDiagnostics({ ...common, devices: [highPending, lowDevice] });
    const firstLow = first.find((diagnostic) => diagnostic.deviceId === 'ev-2')!;
    const firstLowHours = buildHoursFromHorizonPlan(firstLow)!;
    const lowLatest = {
      revision: 1,
      revisedAtMs: NOW_MS,
      computedFromPricesUpTo: deadlineAtMs,
      reason: 'flow_card' as const,
      hours: firstLowHours,
      energyNeededKWh: firstLow.horizonPlan!.energyNeededKWh,
      planStatus: resolvedTrajectoryStatus(firstLow) ?? 'on_track' as const,
      allocationContextSignature: firstLow.allocationContextSignature,
      devicePriority: 2,
    };
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-2': {
          deviceId: 'ev-2',
          deviceName: 'Second EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: objective.targetPercent,
          deadlineAtMs,
          startedAtMs: NOW_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc',
            targetTemperatureC: null,
            targetPercent: objective.targetPercent,
            deadlineAtMs,
            enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS, hours: firstLowHours },
          original: lowLatest,
          latest: lowLatest,
        },
      },
    };

    const coordinated = buildDeferredObjectiveDiagnostics({
      ...common,
      nowMs: NOW_MS + 30 * 60 * 1000,
      devices: [highReady, lowDevice],
      activePlans,
    });
    const coordinatedHigh = coordinated.find((diagnostic) => diagnostic.deviceId === 'ev-1');
    const coordinatedLow = coordinated.find((diagnostic) => diagnostic.deviceId === 'ev-2');
    const coordinatedHighHours = new Set(
      coordinatedHigh?.horizonPlan?.plannedBuckets
        .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
        .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS),
    );
    const coordinatedLowHours = coordinatedLow?.horizonPlan?.plannedBuckets
      .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
      .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS) ?? [];
    expect(first.find((diagnostic) => diagnostic.deviceId === 'ev-1')?.horizonPlan).toBeUndefined();
    expect(coordinatedLow?.allocationContextSignature).not.toBe(firstLow.allocationContextSignature);
    expect(coordinatedLow?.horizonPlan?.frozenRead).not.toBe(true);
    expect(coordinatedLow?.replaceCommitment).toBe(true);
    expect(coordinatedLowHours.every((hour) => !coordinatedHighHours.has(hour))).toBe(true);
  });

  it('immediately coordinates a legacy lower commitment with no allocation signature', () => {
    const deadlineAtMs = NOW_MS + 5 * HOUR_MS;
    const objective = { ...buildSettings().objectivesByDeviceId['ev-1'], deadlineAtMs };
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: { 'ev-1': objective, 'ev-2': objective },
    });
    const hours = [{ startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 1, plannedAdmissionPowerKw: 1 }];
    const latest = {
      revision: 1,
      revisedAtMs: NOW_MS,
      computedFromPricesUpTo: deadlineAtMs,
      reason: 'flow_card' as const,
      hours,
      energyNeededKWh: 1,
      planStatus: 'on_track' as const,
    };
    const buildPlan = (deviceId: string, deviceName: string, priority: number) => ({
      deviceId,
      deviceName,
      objectiveKind: 'ev_soc' as const,
      targetTemperatureC: null,
      targetPercent: objective.targetPercent,
      deadlineAtMs,
      startedAtMs: NOW_MS,
      pending: false,
      objectiveSignature: buildObjectiveSignature({
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: objective.targetPercent,
        deadlineAtMs,
        enforcement: 'soft',
      }),
      commitment: { committedAtMs: NOW_MS, hours },
      original: { ...latest, devicePriority: priority },
      latest: { ...latest, devicePriority: priority },
    });
    const profile = buildPowerTracker().objectiveProfiles?.['ev-1'];
    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS + 30 * 60 * 1000,
      timeZone: 'UTC',
      devices: [buildDevice({ priority: 1 }), buildDevice({ id: 'ev-2', name: 'Second EV', priority: 2 })],
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'ev-1': profile!, 'ev-2': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
      hardCapKw: 1.5,
      activePlans: {
        version: 1,
        plansByDeviceId: {
          'ev-1': buildPlan('ev-1', 'Driveway EV', 1),
          'ev-2': buildPlan('ev-2', 'Second EV', 2),
        },
      },
    });
    const low = diagnostics.find((diagnostic) => diagnostic.deviceId === 'ev-2');
    expect(low?.horizonPlan?.frozenRead).not.toBe(true);
    expect(low?.replaceCommitment).toBe(true);
  });

  it('re-ranks a transiently missing higher task before a compacted lower task, then releases it', () => {
    const deadlineAtMs = NOW_MS + 5 * HOUR_MS;
    const objective = {
      ...buildSettings({ targetPercent: 50 }).objectivesByDeviceId['ev-1'],
      deadlineAtMs,
    };
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: { 'z-high': objective, 'a-low': objective },
    });
    const committedHours = [
      { startsAtMs: NOW_MS, plannedKWh: 1, plannedAdmissionPowerKw: 1 },
      { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1, plannedAdmissionPowerKw: 1 },
    ];
    const latest = {
      revision: 1,
      revisedAtMs: NOW_MS - HOUR_MS,
      computedFromPricesUpTo: deadlineAtMs,
      reason: 'flow_card' as const,
      hours: committedHours,
      energyNeededKWh: 2,
      planStatus: 'on_track' as const,
    };
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'z-high': {
          deviceId: 'z-high',
          deviceName: 'Higher EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc',
            targetTemperatureC: null,
            targetPercent: 50,
            deadlineAtMs,
            enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours: committedHours },
          original: latest,
          latest,
        },
      },
    };
    const high = buildDevice({ id: 'z-high', name: 'Higher EV', priority: 1 });
    // The visible-home producer has compacted the survivor to 1. The allocation
    // roster must still put the grace-retained higher task first, despite the
    // lower device id sorting lexically before it.
    const low = buildDevice({ id: 'a-low', name: 'Lower EV', priority: 1 });
    const tracker = new PriorityAllocationTracker();
    tracker.observe({ devices: [high, { ...low, priority: 2 }], nowMs: NOW_MS - 30_000 });
    const profile = buildPowerTracker().objectiveProfiles?.['ev-1'];
    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [low],
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'z-high': profile!, 'a-low': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
      priceOptimizationEnabled: true,
      activePlans,
      hardCapKw: 1.5,
      priorityAllocationTracker: tracker,
      getBasePriorityForDevice: (deviceId) => (deviceId === 'z-high' ? 1 : 2),
    });
    const lowDiagnostic = diagnostics.find((diagnostic) => diagnostic.deviceId === 'a-low');
    const lowHours = lowDiagnostic
      ?.horizonPlan?.plannedBuckets
      .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
      .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS) ?? [];

    expect(diagnostics[0]).toMatchObject({
      deviceId: 'z-high',
      devicePriority: 1,
      reasonCode: 'objective_missing_device',
    });
    expect(lowDiagnostic?.devicePriority).toBe(2);
    expect(lowHours).not.toContain(NOW_MS);
    expect(lowHours).not.toContain(NOW_MS + 2 * HOUR_MS);

    const afterGrace = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS + 1,
      timeZone: 'UTC',
      devices: [low],
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'z-high': profile!, 'a-low': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
      priceOptimizationEnabled: true,
      activePlans,
      hardCapKw: 1.5,
      priorityAllocationTracker: tracker,
      getBasePriorityForDevice: (deviceId) => (deviceId === 'z-high' ? 1 : 2),
    });
    const releasedLow = afterGrace.find((diagnostic) => diagnostic.deviceId === 'a-low');
    const releasedLowHours = releasedLow
      ?.horizonPlan?.plannedBuckets
      .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
      .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS) ?? [];

    expect(afterGrace.find((diagnostic) => diagnostic.deviceId === 'z-high')).toMatchObject({
      deviceId: 'z-high',
      reasonCode: 'objective_missing_device',
    });
    expect(releasedLow?.devicePriority).toBe(1);
    expect(releasedLowHours).toContain(NOW_MS + 2 * HOUR_MS);
  });

  it('keeps a signed lower commitment frozen while a higher device is transiently missing', () => {
    const deadlineAtMs = NOW_MS + 5 * HOUR_MS;
    const objective = {
      ...buildSettings({ targetPercent: 50 }).objectivesByDeviceId['ev-1'],
      deadlineAtMs,
    };
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: { 'ev-1': objective, 'ev-2': objective },
    });
    const buildPlan = (params: {
      deviceId: string;
      deviceName: string;
      priority: number;
      hours: { startsAtMs: number; plannedKWh: number; plannedAdmissionPowerKw: number }[];
    }) => {
      const latest = {
        revision: 1,
        revisedAtMs: NOW_MS,
        computedFromPricesUpTo: deadlineAtMs,
        reason: 'flow_card' as const,
        hours: params.hours,
        energyNeededKWh: params.hours.reduce((sum, hour) => sum + hour.plannedKWh, 0),
        planStatus: 'on_track' as const,
        devicePriority: params.priority,
        allocationContextSignature: `signed-${params.deviceId}`,
      };
      return {
        deviceId: params.deviceId,
        deviceName: params.deviceName,
        objectiveKind: 'ev_soc' as const,
        targetTemperatureC: null,
        targetPercent: 50,
        deadlineAtMs,
        startedAtMs: NOW_MS,
        pending: false,
        objectiveSignature: buildObjectiveSignature({
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          enforcement: 'soft',
        }),
        commitment: { committedAtMs: NOW_MS, hours: params.hours },
        original: latest,
        latest,
      };
    };
    const high = buildDevice({ priority: 1 });
    const low = buildDevice({ id: 'ev-2', name: 'Second EV', priority: 2 });
    const tracker = new PriorityAllocationTracker();
    tracker.observe({ devices: [high, low], nowMs: NOW_MS });
    const profile = buildPowerTracker().objectiveProfiles?.['ev-1'];
    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS + 30 * 60 * 1000,
      timeZone: 'UTC',
      devices: [low],
      settings,
      powerTracker: buildPowerTracker({ objectiveProfiles: { 'ev-1': profile!, 'ev-2': profile! } }),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
      hardCapKw: 1.5,
      priorityAllocationTracker: tracker,
      activePlans: {
        version: 1,
        plansByDeviceId: {
          'ev-1': buildPlan({
            deviceId: 'ev-1',
            deviceName: 'Driveway EV',
            priority: 1,
            hours: [{ startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1, plannedAdmissionPowerKw: 1 }],
          }),
          'ev-2': buildPlan({
            deviceId: 'ev-2',
            deviceName: 'Second EV',
            priority: 2,
            hours: [{ startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 1, plannedAdmissionPowerKw: 1 }],
          }),
        },
      },
    });
    const missingHigh = diagnostics.find((diagnostic) => diagnostic.deviceId === 'ev-1');
    const signedLow = diagnostics.find((diagnostic) => diagnostic.deviceId === 'ev-2');

    expect(missingHigh?.horizonPlan).toBeUndefined();
    expect(signedLow?.horizonPlan?.frozenRead).toBe(true);
    expect(signedLow?.replaceCommitment).toBeUndefined();
  });

  it('clips legacy admission inference to a deadline inside the final hour', () => {
    const deadlineAtMs = NOW_MS + 30 * 60 * 1000;
    const rawObjective = {
      ...buildSettings({ targetPercent: 45 }).objectivesByDeviceId['ev-1'],
      deadlineAtMs,
    };
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: { 'ev-1': rawObjective },
    });
    const objective = settings.objectivesByDeviceId['ev-1']!;
    const hours = [{ startsAtMs: NOW_MS, plannedKWh: 1 }];
    const latest = {
      revision: 1,
      revisedAtMs: NOW_MS - HOUR_MS,
      computedFromPricesUpTo: deadlineAtMs,
      reason: 'flow_card' as const,
      hours,
      energyNeededKWh: 1,
      planStatus: 'on_track' as const,
      devicePriority: 1,
    };
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 45,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc',
            targetTemperatureC: null,
            targetPercent: 45,
            deadlineAtMs,
            enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours },
          original: latest,
          latest,
        },
      },
    };
    const device = buildDevice({ priority: 1 });
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [device],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
      activePlans,
      hardCapKw: 10,
    });
    const [reservation] = buildPriorityReservations({
      diagnostic: diagnostic!,
      objective,
      device,
      activePlans,
      hardCapKw: 10,
    });

    expect(reservation?.admissionPowerKw).toBe(2);
    expect(reservation?.energySegments).toEqual([{
      startMs: NOW_MS,
      endMs: deadlineAtMs,
      plannedKWh: 1,
    }]);
  });

  it('plans a persisted EV SoC objective through price-shaped horizon buckets', () => {
    // 4 kWh need at 1 kW low step needs 4 hours; the 1-hour deadline reserve
    // adds one more hour, so deadline at 22:00 (5 hours after NOW_MS=17:00)
    // keeps the plan on_track with the reserve untouched.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'on_track' },
      reasonCode: 'planned_with_margin',
      currentPercent: 40,
      targetPercent: 60,
      energyNeededKWh: 4,
      kWhPerUnitBanded: 0.2,
      expectedStepId: 'low',
      horizonBucketCount: 5,
    });
    expect(diagnostic?.horizonPlan?.plannedBuckets.every((bucket) => bucket.price === 5)).toBe(true);
  });

  it('drops the budget attribution for an exempt-from-budget task on a spent budget', () => {
    // Every hour's controlled share is 0 — the budget has nothing left to give.
    const exhausted = {
      plannedControlledKWh: Array.from({ length: 24 }, () => 0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
    };
    const baseSettings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' }));
    const exemptSettings = {
      ...baseSettings,
      objectivesByDeviceId: {
        'ev-1': { ...baseSettings.objectivesByDeviceId['ev-1']!, rescue: { exemptFromBudget: 'always' as const } },
      },
    };
    const run = (settings: typeof baseSettings) => buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(exhausted),
      priceOptimizationEnabled: true,
    })[0];

    // Control: without rescue the spent budget collapses the per-bucket caps to zero
    // and the plan is attributed to the daily budget.
    expect(run(baseSettings)?.reasonCode).toBe('limited_by_daily_budget');
    // Exempt-always lifts the caps, so the plan must NOT be attributed to the daily
    // budget — otherwise a capacity/time-limited miss is misattributed to a budget
    // this task is exempt from.
    expect(run(exemptSettings)?.reasonCode).not.toBe('limited_by_daily_budget');
  });

  it('re-solves a committed schedule when budget rescue is enabled after the first plan', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({
      deadlineLocalTime: '20:00',
      targetPercent: 50,
      rescue: { exemptFromBudget: 'always' },
    }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const oldCommitment = [{ startsAtMs: NOW_MS, plannedKWh: 1 }];
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: JSON.stringify(['ev_soc', null, 50, deadlineAtMs, 'soft']),
          commitment: {
            committedAtMs: NOW_MS - HOUR_MS,
            hours: oldCommitment,
          },
          original: {
            revision: 1,
            revisedAtMs: NOW_MS - HOUR_MS,
            computedFromPricesUpTo: NOW_MS + HOUR_MS,
            reason: 'flow_card',
            hours: oldCommitment,
            energyNeededKWh: 2,
            planStatus: 'cannot_meet',
          },
          latest: {
            revision: 1,
            revisedAtMs: NOW_MS - HOUR_MS,
            computedFromPricesUpTo: NOW_MS + HOUR_MS,
            reason: 'flow_card',
            hours: oldCommitment,
            energyNeededKWh: 2,
            planStatus: 'cannot_meet',
          },
        },
      },
    };
    const exhausted = {
      allowedCumKWh: Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20)),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
    };
    const prices = Array.from({ length: 24 }, () => 30);
    prices[new Date(NOW_MS + HOUR_MS).getUTCHours()] = 5;

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ ...exhausted, prices }),
      priceOptimizationEnabled: true,
      activePlans,
    });

    const plannedBuckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).not.toBe('cannot_meet');
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS + HOUR_MS).toISOString())).toBeCloseTo(1);
    expect(diagnostic?.horizonPlan?.plannedUsefulEnergyKWh).toBeCloseTo(2);
  });

  it('uses a committed active-plan schedule instead of moving to newly preferred hours', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({
      deadlineLocalTime: '20:00',
      targetPercent: 50,
    }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: JSON.stringify(['ev_soc', null, 50, deadlineAtMs, 'soft']),
          commitment: {
            committedAtMs: NOW_MS - HOUR_MS,
            hours: [
              { startsAtMs: NOW_MS, plannedKWh: 1 },
              { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 },
            ],
          },
          original: {
            revision: 1,
            revisedAtMs: NOW_MS - HOUR_MS,
            computedFromPricesUpTo: NOW_MS + 2 * HOUR_MS,
            reason: 'flow_card',
            hours: [
              { startsAtMs: NOW_MS, plannedKWh: 1 },
              { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 },
            ],
            energyNeededKWh: 2,
            planStatus: 'on_track',
          },
          latest: {
            revision: 1,
            revisedAtMs: NOW_MS - HOUR_MS,
            computedFromPricesUpTo: NOW_MS + 2 * HOUR_MS,
            reason: 'flow_card',
            hours: [
              { startsAtMs: NOW_MS, plannedKWh: 1 },
              { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 },
            ],
            energyNeededKWh: 2,
            planStatus: 'on_track',
          },
        },
      },
    };
    const prices = Array.from({ length: 24 }, () => 30);
    prices[new Date(NOW_MS + HOUR_MS).getUTCHours()] = 5;

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices }),
      priceOptimizationEnabled: true,
      activePlans,
    });

    const plannedBuckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    expect(diagnostic?.expectedStepId).toBe('low');
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS).toISOString())).toBeCloseTo(1);
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS + HOUR_MS).toISOString())).toBe(0);
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS + 2 * HOUR_MS).toISOString())).toBeCloseTo(1);
  });

  // Per-cycle commitment collapse: mid-hour the build serves a frozen read (no
  // allocator); only the `:58` settle window / bootstrap re-allocates. The frozen
  // assembler stamps `frozen-` bucket ids, which the allocator never produces — a
  // reliable marker for "which path ran" without mocking the allocator.
  const buildCommittedEvPlans = (
    deadlineAtMs: number,
    latestOverrides: Record<string, unknown> = {},
    hourOverrides: Array<{ startsAtMs: number; plannedKWh: number }> | null = null,
  ): DeferredObjectiveActivePlansV1 => {
    const hours = hourOverrides ?? [
      { startsAtMs: NOW_MS, plannedKWh: 1 },
      { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 },
    ];
    const latest = {
      revision: 1,
      revisedAtMs: NOW_MS - HOUR_MS,
      computedFromPricesUpTo: NOW_MS + 2 * HOUR_MS,
      reason: 'flow_card' as const,
      hours,
      energyNeededKWh: 2,
      planStatus: 'on_track' as const,
      ...latestOverrides,
    };
    return {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: JSON.stringify(['ev_soc', null, 50, deadlineAtMs, 'soft']),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours },
          original: latest,
          latest,
        },
      },
    };
  };

  it('serves a frozen read mid-hour (no allocator) and re-allocates in the :58 settle window', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const activePlans = buildCommittedEvPlans(deadlineAtMs);
    const run = (nowMs: number) => buildDeferredObjectiveDiagnostics({
      nowMs,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans,
    })[0];

    // Mid-hour (NOW_MS is :00) ⇒ frozen read: every planned bucket carries a
    // `frozen-` id, i.e. the allocator did NOT run.
    const midHour = run(NOW_MS);
    const midBuckets = midHour?.horizonPlan?.plannedBuckets ?? [];
    expect(midBuckets.length).toBeGreaterThan(0);
    expect(midBuckets.every((b) => b.id.startsWith('frozen-'))).toBe(true);

    // :58 settle window ⇒ allocator re-runs: no `frozen-` ids.
    const settle = run(NOW_MS + 58 * 60 * 1000);
    const settleBuckets = settle?.horizonPlan?.plannedBuckets ?? [];
    expect(settleBuckets.some((b) => b.id.startsWith('frozen-'))).toBe(false);
  });

  // The frozen read replays the settle's persisted `floorShortfallCause` into a
  // control decision, and `isOptionalFloorShortfallCause` (`activePlanSettings.ts`)
  // admits ANY string so a cause from a newer build survives rehydration. These pin
  // the cause -> claim contract end to end through the real bridge, including that an
  // unrecognised string can only ever read as the release posture — never as a claim
  // on the hour.
  const frozenClaimForCause = (cause: unknown): string | undefined => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    // Commit only a LATER hour, so the current hour is one the commitment skipped —
    // the case where the cause decides between `unclaimed` and `released`.
    const activePlans = buildCommittedEvPlans(
      deadlineAtMs,
      { floorShortfallCause: cause },
      [{ startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 1 }],
    );
    return buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans,
    })[0]?.horizonPlan?.currentHourClaim;
  };

  it('keeps an unbooked frozen hour for a known budget-bound cause', () => {
    expect(frozenClaimForCause('budget')).toBe('unclaimed');
    expect(frozenClaimForCause('time_capacity')).toBe('unclaimed');
  });

  it('releases an unbooked frozen hour for a cause the task can finish without', () => {
    expect(frozenClaimForCause('step_power')).toBe('released');
    expect(frozenClaimForCause('none')).toBe('released');
    expect(frozenClaimForCause(undefined)).toBe('released');
  });

  it('degrades an unrecognised persisted cause to the release posture, not a claim', () => {
    // A forward-compat string from a newer build, and outright garbage that slipped
    // the permissive validator. Neither may invent a claim on the hour.
    expect(frozenClaimForCause('some_future_cause')).toBe('released');
    expect(frozenClaimForCause('')).toBe('released');
  });

  it('releases an expired frozen commitment at the exact deadline boundary', () => {
    const deadlineAtMs = NOW_MS;
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineAtMs, targetPercent: 50 }));
    const device = buildDevice({
      controllable: false,
      controlModel: 'binary_power',
      stateOfCharge: stateOfChargeFixture({ percent: 43, observedAtMs: NOW_MS }),
    });
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [device],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans: buildCommittedEvPlans(deadlineAtMs),
    });

    const buckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    expect(buckets.some((b) => b.id.startsWith('frozen-'))).toBe(false);
    expect(diagnostic?.horizonPlan?.currentBucket ?? null).toBeNull();
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('cannot_meet');
    expect(diagnostic?.reasonCode).toBe('deadline_passed');
    const decision = applyDeferredObjectiveAdmission(diagnostic ? [diagnostic] : [], [device]).get('ev-1');
    expect(decision).toEqual({ kind: 'idle', budgetExempt: false, releaseIntent: 'binary_release' });
  });

  it('runs the allocator at bootstrap when no commitment covers the active hour', () => {
    // No activePlans ⇒ resolveCommittedHours undefined ⇒ fresh allocation even mid-hour.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans: null,
    });
    const buckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.id.startsWith('frozen-'))).toBe(false);
  });

  it('goes inactive (not frozen) when price optimization is OFF, even with a commitment', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: false, // deliberate config off — NOT a transient gap
      activePlans: buildCommittedEvPlans(deadlineAtMs),
    });
    // Price-dependent objective with the feature off ⇒ inactive (device returns to
    // normal control), NOT a frozen read of the stale price-optimized plan.
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBeUndefined();
    expect(diagnostic?.reasonCode).toBe('objective_price_feature_disabled');
    expect(diagnostic?.horizonPlan).toBeUndefined();
  });

  it('frozen read uses the settled latest.hours kWh, not the stale commitment floor', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    // A :58 kWh refinement (e.g. measured_deviation) on the SAME hour set updates
    // `latest` but not `commitment` (the merge only re-commits on a schedule change).
    const commitmentHours = [{ startsAtMs: NOW_MS, plannedKWh: 1 }];
    const latestHours = [{ startsAtMs: NOW_MS, plannedKWh: 3 }]; // refined up
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 50, deadlineAtMs, enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours: commitmentHours },
          original: {
            revision: 1, revisedAtMs: NOW_MS - HOUR_MS, computedFromPricesUpTo: NOW_MS,
            reason: 'flow_card', hours: commitmentHours, energyNeededKWh: 1, planStatus: 'on_track',
          },
          latest: {
            revision: 2, revisedAtMs: NOW_MS, computedFromPricesUpTo: NOW_MS,
            reason: 'measured_deviation', hours: latestHours, energyNeededKWh: 3, planStatus: 'on_track',
          },
        },
      },
    };
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans,
    });
    // Frozen read mid-hour ⇒ current bucket reflects the SETTLED 3 kWh, not the stale 1.
    expect(diagnostic?.horizonPlan?.plannedBuckets.every((b) => b.id.startsWith('frozen-'))).toBe(true);
    expect(diagnostic?.horizonPlan?.currentBucket?.plannedUsefulEnergyKWh).toBe(3);
    const [reservation] = buildPriorityReservations({
      diagnostic: diagnostic!,
      objective: settings.objectivesByDeviceId['ev-1']!,
      device: buildDevice(),
      activePlans,
      hardCapKw: 10,
    });
    expect(reservation?.plannedKWh).toBe(3);
  });

  it('does not serve a frozen read from a committed plan with no latest revision', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const hours = [{ startsAtMs: NOW_MS, plannedKWh: 1 }];
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 50, deadlineAtMs, enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours },
          original: null,
          latest: null,
        },
      },
    };

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans,
    });
    const buckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.id.startsWith('frozen-'))).toBe(false);
  });

  it('frozen milestone deferral uses latest.hours, not stale commitment.hours', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const commitmentHours = [
      { startsAtMs: NOW_MS, plannedKWh: 1, plannedUnitMilestone: 46, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 1, plannedUnitMilestone: 48 },
    ];
    const latestHours = [
      { startsAtMs: NOW_MS, plannedKWh: 1, plannedUnitMilestone: 42, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 1, plannedUnitMilestone: 48 },
    ];
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 50, deadlineAtMs, enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours: commitmentHours },
          original: {
            revision: 1, revisedAtMs: NOW_MS - HOUR_MS, computedFromPricesUpTo: NOW_MS,
            reason: 'flow_card', hours: commitmentHours, energyNeededKWh: 2, planStatus: 'on_track',
          },
          latest: {
            revision: 2, revisedAtMs: NOW_MS, computedFromPricesUpTo: NOW_MS,
            reason: 'measured_deviation', hours: latestHours, energyNeededKWh: 2, planStatus: 'on_track',
          },
        },
      },
    };

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({ stateOfCharge: stateOfChargeFixture({ percent: 43, observedAtMs: NOW_MS }) })],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans,
    });

    expect(diagnostic?.horizonPlan?.plannedBuckets.every((b) => b.id.startsWith('frozen-'))).toBe(true);
    expect(diagnostic?.horizonPlan?.priceDeferralEligible).toBe(true);
  });

  it('settle milestone deferral uses latest.hours, not stale commitment.hours', () => {
    const settleNowMs = NOW_MS + 58 * 60 * 1000;
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const commitmentHours = [
      { startsAtMs: NOW_MS, plannedKWh: 1, plannedUnitMilestone: 46, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 1, plannedUnitMilestone: 48 },
    ];
    const latestHours = [
      { startsAtMs: NOW_MS, plannedKWh: 1, plannedUnitMilestone: 42, cheaperHourAhead: true },
      { startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 1, plannedUnitMilestone: 48 },
    ];
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 50, deadlineAtMs, enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - HOUR_MS, hours: commitmentHours },
          original: {
            revision: 1, revisedAtMs: NOW_MS - HOUR_MS, computedFromPricesUpTo: NOW_MS,
            reason: 'flow_card', hours: commitmentHours, energyNeededKWh: 2, planStatus: 'on_track',
          },
          latest: {
            revision: 2, revisedAtMs: NOW_MS, computedFromPricesUpTo: NOW_MS,
            reason: 'measured_deviation', hours: latestHours, energyNeededKWh: 2, planStatus: 'on_track',
          },
        },
      },
    };
    const prices = Array.from({ length: 24 }, () => 30);
    prices[new Date(NOW_MS + HOUR_MS).getUTCHours()] = 5;

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: settleNowMs,
      timeZone: 'UTC',
      devices: [buildDevice({ stateOfCharge: stateOfChargeFixture({ percent: 43, observedAtMs: settleNowMs }) })],
      settings,
      powerTracker: buildPowerTracker({
        objectiveProfiles: {
          'ev-1': {
            kind: 'ev_soc',
            updatedAtMs: settleNowMs,
            lastSample: { observedAtMs: settleNowMs, value: 43, unit: 'percent' },
            kwhPerUnit: {
              sampleCount: 4,
              mean: 0.2,
              m2: 0,
              min: 0.2,
              max: 0.2,
              confidence: 'medium',
              lastUpdatedMs: settleNowMs,
            },
            acceptedSamples: 4,
            rejectedSamples: 0,
          },
        },
      }),
      dailyBudgetSnapshot: buildSnapshot({ nowMs: settleNowMs, prices }),
      priceOptimizationEnabled: true,
      activePlans,
    });

    const buckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.id.startsWith('frozen-'))).toBe(false);
    expect(diagnostic?.horizonPlan?.priceDeferralEligible).toBe(true);
  });

  it('runs the allocator mid-hour when the commitment has no current-or-future hour (all elapsed)', () => {
    const settings = normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00', targetPercent: 50 }));
    const deadlineAtMs = settings.objectivesByDeviceId['ev-1']!.deadlineAtMs;
    const elapsedHours = [
      { startsAtMs: NOW_MS - 2 * HOUR_MS, plannedKWh: 1 },
      { startsAtMs: NOW_MS - HOUR_MS, plannedKWh: 1 },
    ];
    const latest = {
      revision: 1,
      revisedAtMs: NOW_MS - 3 * HOUR_MS,
      computedFromPricesUpTo: NOW_MS,
      reason: 'flow_card' as const,
      hours: elapsedHours,
      energyNeededKWh: 2,
      planStatus: 'on_track' as const,
    };
    const activePlans: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        'ev-1': {
          deviceId: 'ev-1',
          deviceName: 'Driveway EV',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 50,
          deadlineAtMs,
          startedAtMs: NOW_MS - 3 * HOUR_MS,
          pending: false,
          objectiveSignature: buildObjectiveSignature({
            objectiveKind: 'ev_soc', targetTemperatureC: null, targetPercent: 50, deadlineAtMs, enforcement: 'soft',
          }),
          commitment: { committedAtMs: NOW_MS - 3 * HOUR_MS, hours: elapsedHours },
          original: latest,
          latest,
        },
      },
    };
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans,
    });
    const buckets = diagnostic?.horizonPlan?.plannedBuckets ?? [];
    // All committed hours elapsed + a positive need ⇒ NOT frozen; the fresh allocator
    // (phase-2 expansion) books the now-needed hours rather than idling until :58.
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.id.startsWith('frozen-'))).toBe(false);
  });

  it('serves a behind-temperature committed device frozen mid-hour (no cold-start routing)', () => {
    const settings = normalizeDeferredObjectiveSettings(buildTemperatureSettings());
    const deadlineAtMs = settings.objectivesByDeviceId['heater-1']!.deadlineAtMs;
    const buildTempPlans = (currentHourBooked: boolean): DeferredObjectiveActivePlansV1 => {
      const hours = [
        ...(currentHourBooked ? [{ startsAtMs: NOW_MS, plannedKWh: 2 }] : []),
        { startsAtMs: NOW_MS + 2 * HOUR_MS, plannedKWh: 2 },
      ];
      const latest = {
        revision: 1,
        revisedAtMs: NOW_MS - HOUR_MS,
        computedFromPricesUpTo: NOW_MS + 2 * HOUR_MS,
        reason: 'flow_card' as const,
        hours,
        energyNeededKWh: 8,
        planStatus: 'on_track' as const,
      };
      return {
        version: 1,
        plansByDeviceId: {
          'heater-1': {
            deviceId: 'heater-1',
            deviceName: 'Connected 300',
            objectiveKind: 'temperature',
            targetTemperatureC: 65,
            targetPercent: null,
            deadlineAtMs,
            startedAtMs: NOW_MS - HOUR_MS,
            pending: false,
            objectiveSignature: buildObjectiveSignature({
              objectiveKind: 'temperature', targetTemperatureC: 65, targetPercent: null, deadlineAtMs, enforcement: 'soft',
            }),
            commitment: { committedAtMs: NOW_MS - HOUR_MS, hours },
            original: latest,
            latest,
          },
        },
      };
    };
    const run = (plans: DeferredObjectiveActivePlansV1) => buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice()],
      settings,
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
      activePlans: plans,
    })[0];

    // Behind (55 °C vs 65 °C target) + current hour booked: NO cold-start routing —
    // the device is served frozen and delivers up to the committed hour's milestone.
    // Whether the current hour should have been booked at all is the allocator's
    // `:58` decision, read off the commitment; mid-hour does no future-fit proof.
    const booked = run(buildTempPlans(true));
    const bookedBuckets = booked?.horizonPlan?.plannedBuckets ?? [];
    expect(bookedBuckets.length).toBeGreaterThan(0);
    expect(bookedBuckets.every((b) => b.id.startsWith('frozen-'))).toBe(true);
    // Current hour not booked (future-only) ⇒ also frozen; current bucket carries no
    // energy so admission idles it this hour.
    const deferred = run(buildTempPlans(false));
    const deferredBuckets = deferred?.horizonPlan?.plannedBuckets ?? [];
    expect(deferredBuckets.length).toBeGreaterThan(0);
    expect(deferredBuckets.every((b) => b.id.startsWith('frozen-'))).toBe(true);
    expect(deferred?.horizonPlan?.currentBucket).toBeNull();
  });

  it('plans a persisted temperature objective from learned kWh per degree', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice()],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'temperature',
      trajectory: { kind: 'resolved', status: 'on_track' },
      reasonCode: 'planned_with_margin',
      currentTemperatureC: 55,
      targetTemperatureC: 65,
      energyNeededKWh: 8,
      kWhPerUnitBanded: 0.8,
      expectedStepId: 'heat',
      horizonBucketCount: 4,
    });
  });

  it('books the soft variance buffer (mean + k·SE) for a temperature objective while the displayed rate stays at the mean', () => {
    // Same heater as the on_track baseline above (mean 0.8 kWh/°C, 55→65 = 10°C
    // → expected 8 kWh), now with real per-sample variance. Temperature
    // objectives are always soft (k = 1). σ = sqrt(m2/(n-1)) = sqrt(0.48/3) =
    // 0.4, n = 4 → standard error SE = 0.4/√4 = 0.2, so the planner books
    // 10 × (0.8 + 1·0.2) = 10 kWh. Guards the producer → diagnostic → planner
    // coupling.
    const buildVarianceTracker = (m2: number): PowerTrackerState => buildTemperaturePowerTracker({
      objectiveProfiles: {
        'heater-1': {
          kind: 'temperature',
          updatedAtMs: NOW_MS,
          lastSample: { observedAtMs: NOW_MS, value: 55, unit: 'degree_c' },
          kwhPerUnit: {
            sampleCount: 4, mean: 0.8, m2, min: 0.4, max: 1.2, confidence: 'low', lastUpdatedMs: NOW_MS,
          },
          acceptedSamples: 4,
          rejectedSamples: 0,
        },
      },
    });
    const run = (m2: number) => buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice()],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildVarianceTracker(m2),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    })[0];

    const buffered = run(0.48); // σ = 0.4
    expect(buffered?.energyNeededKWh).toBeCloseTo(10); // 10 × (0.8 + 1·0.2)
    // Displayed learned rate is the measured mean, NOT the buffered rate.
    expect(buffered?.kWhPerUnitBanded).toBeCloseTo(0.8);

    // Zero variance reproduces the un-buffered baseline (8 kWh).
    expect(run(0)?.energyNeededKWh).toBeCloseTo(8);
  });

  it('books the larger hard buffer (k = 2) for a hard EV deadline', () => {
    // EV objectives can be hard (k = 2); temperature objectives are always
    // soft. SoC 40 → target 60 = 20%, mean 0.2 kWh/%, σ = sqrt(0.03/3) = 0.1,
    // n = 4 → SE = 0.1/√4 = 0.05 → 20 × (0.2 + 2·0.05) = 6 kWh (expected 4).
    // Confirms enforcement raises k end-to-end versus the soft buffer above.
    const tracker = buildPowerTracker({
      objectiveProfiles: {
        'ev-1': {
          kind: 'ev_soc',
          updatedAtMs: NOW_MS,
          lastSample: { observedAtMs: NOW_MS, value: 40, unit: 'percent' },
          kwhPerUnit: {
            sampleCount: 4, mean: 0.2, m2: 0.03, min: 0.1, max: 0.3, confidence: 'low', lastUpdatedMs: NOW_MS,
          },
          acceptedSamples: 4,
          rejectedSamples: 0,
        },
      },
    });
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ enforcement: 'hard' })),
      powerTracker: tracker,
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });
    expect(diagnostic?.energyNeededKWh).toBeCloseTo(6);
    expect(diagnostic?.kWhPerUnitBanded).toBeCloseTo(0.2);
  });

  it('refuses to promise more energy than the per-bucket budget headroom allows', () => {
    // Reproduces the case behind the planning-input card: a heater claiming
    // 31 kWh of need against a horizon whose per-bucket headroom is small
    // enough that the lowest non-zero step can never deliver it. The planner
    // must surface `cannot_meet`, not silently accept the inflated rate.
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00'); // 4 hours after NOW_MS
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice({
        currentTemperature: 20,
        steppedLoadProfile: {
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'heat', planningPowerW: 2000 },
          ],
        },
      })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings({ deadlineAtMs })),
      powerTracker: buildTemperaturePowerTracker({
        objectiveProfiles: {
          'heater-1': {
            kind: 'temperature',
            updatedAtMs: NOW_MS,
            lastSample: { observedAtMs: NOW_MS, value: 20, unit: 'degree_c' },
            kwhPerUnit: {
              sampleCount: 6,
              mean: 0.62,
              m2: 0,
              min: 0.62,
              max: 0.62,
              confidence: 'high',
              lastUpdatedMs: NOW_MS,
            },
            acceptedSamples: 6,
            rejectedSamples: 0,
          },
        },
      }),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => (index + 1) * 2),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1),
      }),
      priceOptimizationEnabled: true,
    });

    // 45 °C × 0.62 kWh/°C = 27.9 kWh of need, but each bucket caps at min(2 kW × 1h, 2 − 1) = 1 kWh.
    expect(diagnostic?.energyNeededKWh).toBeCloseTo(27.9);
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('cannot_meet');
    expect(diagnostic?.horizonPlan?.unplannedUsefulEnergyKWh).toBeGreaterThan(0);
  });

  it('attributes a budget-bound at_risk plan to the daily budget so the UI can explain it', () => {
    // Every horizon bucket (17-20 with the default 21:00 deadline) has a zero
    // controlled share: the budget has nothing left for managed load. The
    // diagnostic must carry that so the UI can tell the user the budget — not the
    // device or the schedule — is the constraint.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        plannedControlledKWh: Array.from({ length: 24 }, () => 0),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
      priceOptimizationEnabled: true,
    });

    // Budget-bound (uncapped it would fit), so the verdict is
    // at_risk/limited_by_daily_budget rather than a physical cannot_meet.
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('at_risk');
    expect(diagnostic?.reasonCode).toBe('limited_by_daily_budget');
  });

  it('is on track and unattributed to the budget when the budget still has room', () => {
    // Use a 22:00 deadline so the 4 kWh need at 1 kW fits inside the primary
    // window without dipping into the 1-hour deadline reserve.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('on_track');
    expect(diagnostic?.reasonCode).not.toBe('limited_by_daily_budget');
  });

  it('plans a temperature objective from a quiescent thermostat whose last observation has aged out', () => {
    // Many Homey thermostat drivers only push capability updates on value
    // change, so a perfectly working device steady at setpoint can sit
    // aged-out for hours — the device snapshot carries an aged `lastFreshDataMs`.
    // Smart-task planning must still credit the last-seen temperature in that
    // case. See `lib/observer/AGENTS.md` for the doctrine and
    // `lib/objectives/deferredObjectives/diagnosticProgress.ts` for why this gate
    // deliberately does not gate on observation freshness.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice({
        lastFreshDataMs: NOW_MS - 2 * 60 * 60 * 1000,
      })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic?.objectiveKind).toBe('temperature');
    expect(diagnostic?.reasonCode).not.toBe('objective_progress_stale');
    expect(diagnostic?.currentTemperatureC).toBe(55);
    expect(diagnostic?.energyNeededKWh).not.toBeNull();
  });

  it('does not plan a temperature objective for a device that has never reported a value', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice({
        currentTemperature: undefined,
        lastFreshDataMs: undefined,
      })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'temperature',
      trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_temperature' },
      reasonCode: 'objective_missing_temperature',
      currentTemperatureC: null,
      energyNeededKWh: null,
    });
  });

  it('does not plan a temperature objective when lastFreshDataMs is non-positive', () => {
    // An epoch <= 0 is treated as uninitialized, not a valid observation
    // timestamp — the device has never reported, which is the one honest
    // "we do not know" state (age never produces one).
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice({
        currentTemperature: 55,
        lastFreshDataMs: 0,
      })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'temperature',
      trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' },
      reasonCode: 'objective_progress_stale',
      currentTemperatureC: 55,
      energyNeededKWh: null,
    });
  });

  it('does not plan a temperature objective when currentTemperature is present but lastFreshDataMs is missing', () => {
    // Asymmetric cold-start guard: a partial snapshot hydration (or older
    // persisted state) might land a `currentTemperature` without a paired
    // timestamp. The "ever observed" gate requires both, so the resolver
    // falls back to `objective_progress_stale` rather than admitting a
    // value with no observation lineage.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice({
        currentTemperature: 55,
        lastFreshDataMs: undefined,
      })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'temperature',
      trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' },
      reasonCode: 'objective_progress_stale',
      currentTemperatureC: 55,
      energyNeededKWh: null,
    });
  });

  it('plans for a bare-connected charger (plugged_in) instead of refusing to', () => {
    // `plugged_in` is commandable — PELS starts a charger in this state (prod
    // 2026-07-26, Easee "Awaiting Authentication"). Blocking here did not merely
    // annotate: it returned `remainingUnits: 0` with a reason code, so the bridge
    // could not reach the satisfied path and the energy resolver computed zero
    // need — the task planned no hours and never admitted the charger.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({ evChargingState: 'plugged_in' })],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({ objectiveKind: 'ev_soc' });
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBeDefined();
  });

  it('rolls a past local deadline to tomorrow and waits when tomorrow prices are missing', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '16:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ includeTomorrow: false }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_price_horizon' },
      reasonCode: 'objective_missing_price_horizon',
      currentPercent: 40,
      energyNeededKWh: 4,
      kWhPerUnitBanded: 0.2,
      deadlineAtMs: Date.UTC(2026, 0, 2, 16, 0, 0),
    });
  });

  it('plans a next-day objective once tomorrow price horizon is available', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '16:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ includeTomorrow: true }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'on_track' },
      horizonBucketCount: 23,
    });
  });

  it('does not plan when the price feature is disabled', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'unavailable', reasonCode: 'objective_price_feature_disabled' },
      reasonCode: 'objective_price_feature_disabled',
      currentPercent: 40,
      targetPercent: 60,
      energyNeededKWh: null,
    });
  });

  it('does not surface stale EV progress when the price feature is disabled', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: NOW_MS - HOUR_MS, unavailable: 'not_reported' }),
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'unavailable', reasonCode: 'objective_price_feature_disabled' },
      reasonCode: 'objective_price_feature_disabled',
      currentPercent: null,
      targetPercent: 60,
      energyNeededKWh: null,
    });
  });

  it('does not clear a satisfied run from stale EV progress while price planning is disabled', () => {
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00');
    const { recorder, saved } = buildHistoryRecorder();
    const [satisfied] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 70, observedAtMs: NOW_MS }),
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineAtMs })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });
    const [staleBelowTarget] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS + HOUR_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: NOW_MS, unavailable: 'not_reported' }),
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineAtMs })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });

    recorder.observe([satisfied!], NOW_MS);
    recorder.observe([staleBelowTarget!], NOW_MS + HOUR_MS);
    recorder.observe([], deadlineAtMs);
    recorder.flushIfDirty();

    const entry = saved()!.entries[0]!;
    expect(staleBelowTarget).toMatchObject({
      trajectory: { kind: 'unavailable', reasonCode: 'objective_price_feature_disabled' },
      reasonCode: 'objective_price_feature_disabled',
      currentPercent: null,
    });
    expect(entry.outcome).toBe('met');
    expect(entry.metAtMs).toBe(NOW_MS);
    expect(entry.finalProgressValue).toBe(70);
  });

  it('marks a met EV objective as satisfied even when price planning is disabled', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 70, observedAtMs: NOW_MS }),
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'energy_already_met',
      currentPercent: 70,
      targetPercent: 60,
      energyNeededKWh: 0,
      expectedStepId: null,
    });
  });

  it('marks a met EV objective as satisfied on a bare-connected charger (plugged_in)', () => {
    // Regression: a connected charger whose fresh SoC already meets the target
    // needs no resume — it must reach the satisfied path rather than any paused
    // verdict. `plugged_in` is a creditable session (`isEvSessionInactive`
    // classifies only `plugged_out` / `plugged_in_discharging`), so nothing
    // upstream may divert it.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        evChargingState: 'plugged_in',
        stateOfCharge: stateOfChargeFixture({ percent: 70, observedAtMs: NOW_MS }),
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'energy_already_met',
      currentPercent: 70,
      targetPercent: 60,
    });
  });

  it('marks a met EV objective as satisfied while waiting for tomorrow prices', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 70, observedAtMs: NOW_MS }),
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({
        deadlineLocalTime: '16:00',
        targetPercent: 60,
      })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot({ includeTomorrow: false }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'ev_soc',
      trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'energy_already_met',
      currentPercent: 70,
      targetPercent: 60,
      energyNeededKWh: 0,
      deadlineAtMs: Date.UTC(2026, 0, 2, 16, 0, 0),
    });
  });

  it('marks a met temperature objective as satisfied when price planning is unavailable', () => {
    for (const priceParams of [
      { priceOptimizationEnabled: false, dailyBudgetSnapshot: buildSnapshot() },
      { priceOptimizationEnabled: true, dailyBudgetSnapshot: buildSnapshot({ includeTomorrow: false }) },
    ]) {
      const [diagnostic] = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [buildTemperatureDevice({ currentTemperature: 66 })],
        settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings({
          deadlineLocalTime: '16:00',
          targetTemperatureC: 65,
        })),
        powerTracker: {},
        ...priceParams,
      });

      expect(diagnostic).toMatchObject({
        objectiveKind: 'temperature',
        trajectory: { kind: 'resolved', status: 'satisfied' },
        reasonCode: 'energy_already_met',
        currentTemperatureC: 66,
        targetTemperatureC: 65,
        energyNeededKWh: 0,
        expectedStepId: null,
      });
    }
  });

  it('returns from satisfied to tracking when progress falls below target before the deadline', () => {
    // Deadline at 22:00 keeps the 4 kWh / 1 kW EV plan on_track when progress
    // drops back below target, with the 1-hour deadline reserve untouched.
    const trackingSettings = normalizeDeferredObjectiveSettings(buildSettings({
      targetPercent: 60,
      deadlineLocalTime: '22:00',
    }));
    const satisfied = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 70, observedAtMs: NOW_MS }),
      })],
      settings: trackingSettings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    })[0];
    const tracking = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: NOW_MS }),
      })],
      settings: trackingSettings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    })[0];

    expect(satisfied).toMatchObject({
      trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
    });
    expect(tracking).toMatchObject({
      trajectory: { kind: 'resolved', status: 'on_track' },
      reasonCode: 'planned_with_margin',
      currentPercent: 40,
      energyNeededKWh: 4,
    });
  });

  it('falls back to the bootstrap kWh-per-percent for EV SoC when no learned profile exists', () => {
    // Target = current + 2% so a bootstrap of 1.0 kWh/% yields a feasible 2 kWh
    // within the ~4h horizon of the default test deadline.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 42 })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      // 2% remaining × 1.0 kWh/% bootstrap = 2 kWh; planner can schedule that
      // within the horizon and reports on_track. The crucial assertion is that
      // status is no longer `unknown` and the source is `bootstrap`.
      trajectory: { kind: 'resolved', status: 'on_track' },
      energyNeededKWh: 2,
      kWhPerUnitBanded: 1,
      kwhPerUnitSource: 'bootstrap',
      rateConfidence: null,
    });
  });

  it('uses the learned profile (not bootstrap) when kWh-per-percent is known', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      kWhPerUnitBanded: 0.2,
      kwhPerUnitSource: 'learned',
      rateConfidence: 'medium',
    });
  });

  it('logs band-aware displayConfidence and the mean-based energy at plan time', () => {
    // The Cause #1 Step 2/3 validation gate needs the band-aware confidence and
    // the variance margin (`energyNeededKWh − energyExpectedKWh`) captured at
    // plan time — neither was in the debug payload before. A learned profile
    // populates both on the diagnostic.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    const payload = buildDeferredObjectiveDebugPayload(diagnostic);
    expect(payload.event).toBe('deferred_objective_horizon_planned');
    // Band-aware confidence is surfaced distinctly from the global rateConfidence.
    expect(payload).toHaveProperty('displayConfidence', diagnostic.displayConfidence);
    // Mean-based estimate present so the margin is derivable from the payload.
    expect(payload).toHaveProperty('energyExpectedKWh', diagnostic.energyExpectedKWh ?? null);
    expect(typeof payload.energyExpectedKWh === 'number' || payload.energyExpectedKWh === null).toBe(true);
  });

  it('surfaces rescue-permission mode and applied flags in the debug payload', () => {
    // Without these, a budget-capped `cannot_meet` cannot be told apart from one
    // where exempt-from-budget was configured but never reached/lifted the plan.
    // The configured mode (`*Mode`) and whether the producer engaged it
    // (`*Applied`) must both be visible at plan time.
    const [withoutRescue] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });
    expect(buildDeferredObjectiveDebugPayload(withoutRescue)).toMatchObject({
      rescueExemptMode: 'off',
      rescueLimitMode: 'off',
      budgetExemptApplied: false,
      limitLowerPriorityApplied: false,
    });

    const [withRescue] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(
        buildSettings({ targetPercent: 60, rescue: { exemptFromBudget: 'always' } }),
      ),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });
    // The configured mode is surfaced verbatim even when the plan stays
    // budget-capped — that combination is exactly the diagnosis signal.
    expect(buildDeferredObjectiveDebugPayload(withRescue).rescueExemptMode).toBe('always');
  });

  it('still reports missing_capacity for temperature objectives without a learned profile (bootstrap is EV-only)', () => {
    const heaterDevice = buildTemperatureDevice({ currentTemperature: 40 });
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00');
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [heaterDevice],
      settings: {
        version: 1,
        objectivesByDeviceId: {
          'heater-1': {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 55,
            deadlineAtMs,
          },
        },
      },
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_capacity' },
      reasonCode: 'objective_missing_capacity',
      kwhPerUnitSource: null,
    });
  });

  it('plans a thermostat-class thermal device without stepped controls via measuredPowerKw fallback', () => {
    // Regression for the Mill-/Adax-/Glamox-shaped Norwegian panel heater
    // class (PELS v2.9.0, 2026-05-23): the device reports class `thermostat`,
    // `onoff` + `target_temperature` + `measure_power`, no stepped controls
    // and no calibrated `planningPowerKw`. With a converged learned profile
    // and live measure_power, `resolveObjectiveSteps` previously returned `[]`
    // (EV-charger branch was the only fallback), so the diagnostic emitted
    // `objective_missing_charge_rate` and `activePlanRecorder` collapsed it
    // to user-visible `pendingReason: 'missing_capacity'` forever. With the
    // thermal fallback (measured → expected → power), the planner builds a
    // horizon plan from the live draw and the smart task can progress.
    const heater = withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({
      controllable: true, available: true,
      id: 'heater-1',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      name: 'Mill v2 Panel Heater',
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      binaryControl: { on: true },
      controlCapabilityId: 'onoff' as const,
      deviceClass: 'thermostat',
      deviceType: 'temperature' as const,
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      currentDrawKw: 1.5,
      // No `steppedLoadProfile`, no `planningPowerKw` — this is what the bug
      // depends on.
    }))) as PlanInputDevice;
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00');
    const powerTracker: PowerTrackerState = {
      objectiveProfiles: {
        'heater-1': {
          kind: 'temperature',
          updatedAtMs: NOW_MS,
          lastSample: { observedAtMs: NOW_MS, value: 19, unit: 'degree_c' },
          // Mill v2 reproducer: 0.30040 kWh/°C, 4 accepted samples, medium
          // confidence; matches the SHS live-walk artifact captured against
          // PELS v2.9.0.
          kwhPerUnit: {
            sampleCount: 4,
            mean: 0.3004,
            m2: 0,
            min: 0.3004,
            max: 0.3004,
            confidence: 'medium',
            lastUpdatedMs: NOW_MS,
          },
          acceptedSamples: 4,
          rejectedSamples: 0,
        },
      },
    };
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [heater],
      settings: {
        version: 1,
        objectivesByDeviceId: {
          'heater-1': {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs,
          },
        },
      },
      powerTracker,
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    // Pre-fix this would have been `trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' }`,
    // `reasonCode: 'objective_missing_charge_rate'`, `horizonPlan: undefined`.
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.reasonCode).not.toBe('objective_missing_charge_rate');
    expect(diagnostic!.reasonCode).not.toBe('objective_missing_capacity');
    // Energy needed = 3 °C × 0.3004 kWh/°C ≈ 0.9012 kWh (no σ, no buffer
    // contribution).
    expect(diagnostic!.energyNeededKWh).toBeCloseTo(0.9012, 3);
    expect(diagnostic!.kWhPerUnitBanded).toBeCloseTo(0.3004, 3);
    // Horizon plan was built — the fallback step plumbed through to the
    // bucket allocator. `expectedStepId` is the synthetic `charge`
    // step the producer emitted; consumers that previously short-circuited
    // on a `null` minimum step now have an actionable plan to render.
    expect(diagnostic!.horizonPlan).toBeDefined();
    expect(diagnostic!.expectedStepId).toBe('charge');
    // The closing assertion: an active-plan recorder fed this diagnostic
    // would now write a non-pending revision (the schedule is non-empty),
    // so `pendingReason: 'missing_capacity'` no longer pins the hero.
    expect(diagnostic!.horizonPlan!.plannedBuckets.some((bucket) => bucket.plannedUsefulEnergyKWh > 0)).toBe(true);
  });

  it('thermal fallback skips zero/negative measuredPowerKw and uses expectedPowerKw when device is idle', () => {
    // A heater between heating cycles reports `measuredPowerKw: 0`; without
    // the `firstPositiveFinite` filter the fallback would publish a useless
    // 0 kW step. The producer must walk down the candidate list to
    // `expectedPowerKw` (load-setting / Homey Energy approximation) so the
    // horizon plan still builds.
    const heater = withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ controllable: true, available: true, currentDrawKw: 0,
      id: 'heater-1',
      name: 'Idle Panel Heater',
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      binaryControl: { on: false },
      controlCapabilityId: 'onoff' as const,
      deviceClass: 'thermostat',
      deviceType: 'temperature' as const,
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      // Heater is currently idle — measured draw is zero.
      measuredPowerKw: 0,
      expectedPowerKw: 2.0, expectedPowerSource: 'default',
    }))) as PlanInputDevice;
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00');
    const powerTracker: PowerTrackerState = {
      objectiveProfiles: {
        'heater-1': {
          kind: 'temperature',
          updatedAtMs: NOW_MS,
          lastSample: { observedAtMs: NOW_MS, value: 19, unit: 'degree_c' },
          kwhPerUnit: {
            sampleCount: 4, mean: 0.3, m2: 0, min: 0.3, max: 0.3, confidence: 'medium', lastUpdatedMs: NOW_MS,
          },
          acceptedSamples: 4,
          rejectedSamples: 0,
        },
      },
    };
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [heater],
      settings: {
        version: 1,
        objectivesByDeviceId: {
          'heater-1': {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs,
          },
        },
      },
      powerTracker,
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic!.reasonCode).not.toBe('objective_missing_charge_rate');
    expect(diagnostic!.horizonPlan).toBeDefined();
    expect(diagnostic!.expectedStepId).toBe('charge');
  });

  // `objective_missing_charge_rate` is no longer reachable for a plain thermostat.
  // The thermal fallback used to require a positive `measuredPowerKw` /
  // `expectedPowerKw` / `powerKw`, and a device nobody had described failed that
  // test; the producer now ends its ladder on a positive default, so such a
  // device plans against 1 kW instead of stalling. That is the outcome the open
  // water-heater P1 asked for.
  //
  // What DOES still reach the gap is the case the protection was built for: a
  // device CONFIGURED as a stepped load whose live `steppedLoadProfile` is
  // missing this cycle (`controlModel === 'stepped_load'` with no profile). Both
  // halves are asserted below; the SDK-boundary regression for the 2026-08-01
  // incident lives in `test/e2e/deferredObjectiveStepGapRestartSdkE2E.test.ts`.
  it('plans a thermostat with no declared power instead of reporting missing_charge_rate', () => {
    const heater = withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ controllable: true, available: true, currentDrawKw: 0,
      id: 'heater-1',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      name: 'Powerless Thermostat',
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      binaryControl: { on: false },
      controlCapabilityId: 'onoff' as const,
      deviceClass: 'thermostat',
      deviceType: 'temperature' as const,
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      // No power fields populated at all.
    }))) as PlanInputDevice;
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00');
    const powerTracker: PowerTrackerState = {
      objectiveProfiles: {
        'heater-1': {
          kind: 'temperature',
          updatedAtMs: NOW_MS,
          lastSample: { observedAtMs: NOW_MS, value: 19, unit: 'degree_c' },
          kwhPerUnit: {
            sampleCount: 4, mean: 0.3, m2: 0, min: 0.3, max: 0.3, confidence: 'medium', lastUpdatedMs: NOW_MS,
          },
          acceptedSamples: 4,
          rejectedSamples: 0,
        },
      },
    };
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [heater],
      settings: {
        version: 1,
        objectivesByDeviceId: {
          'heater-1': {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs,
          },
        },
      },
      powerTracker,
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic!.reasonCode).not.toBe('objective_missing_charge_rate');
    expect(diagnostic!.expectedStepId).toBe('charge');
  });

  it('reports the step-ladder gap for a stepped-configured device with no live profile', () => {
    // Keyed on the producer's resolved gap bit, not on the power figure and not
    // on the `controlModel` tag. The power figure was only ever a proxy and it
    // stopped working as one the moment `expectedPowerKw` became a guaranteed
    // positive number; the tag was a producer-side fact this layer reconstructed.
    // `controlModel` is deliberately ABSENT from this fixture so the case fails if
    // the consumer ever goes back to inferring the gap from it.
    const tank = withTemperatureDiscriminant(withBinaryDiscriminant(withFixtureResidualKw({ controllable: true, available: true, currentDrawKw: 0,
      id: 'heater-1',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      name: 'Water heater with no live ladder',
      commandableNow: true,
      objectiveSessionInactive: false,
      boostSupported: false,
      boostRequested: false,
      hasStandingDemand: true,
      surplusTracking: false,
      confirmedNotDrawing: false,
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      binaryControl: { on: false },
      controlCapabilityId: 'onoff' as const,
      deviceClass: 'thermostat',
      deviceType: 'temperature' as const,
      steppedLadderMissing: true as const,
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      // No `steppedLoadProfile`: configured stepped, but the ladder is missing —
      // which is what the producer stamped `steppedLadderMissing` for.
    }))) as PlanInputDevice;
    const deadlineAtMs = resolveDeadlineAtMsFor('21:00');
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [tank],
      settings: {
        version: 1,
        objectivesByDeviceId: {
          'heater-1': {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs,
          },
        },
      },
      powerTracker: {
        objectiveProfiles: {
          'heater-1': {
            kind: 'temperature',
            updatedAtMs: NOW_MS,
            lastSample: { observedAtMs: NOW_MS, value: 19, unit: 'degree_c' },
            kwhPerUnit: {
              sampleCount: 4, mean: 0.3, m2: 0, min: 0.3, max: 0.3, confidence: 'medium', lastUpdatedMs: NOW_MS,
            },
            acceptedSamples: 4,
            rejectedSamples: 0,
          },
        },
      },
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_charge_rate' },
      reasonCode: 'objective_missing_charge_rate',
    });
  });

  it('marks a met objective as satisfied without requiring a charger rate', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: stateOfChargeFixture({ percent: 70, observedAtMs: NOW_MS }),
        steppedLoadProfile: undefined,
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      expectedStepId: null,
    });
  });

  it('arms a 1-hour reserve and reports on_track when energy fits before it', () => {
    // 4 kWh needed at 1 kW = 4 charging hours; 5-hour horizon (17:00 → 22:00)
    // leaves the final hour (21:00 → 22:00) as reserve. The plan lands in
    // the four primary hours, so the reserve stays untouched.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'on_track' },
      reasonCode: 'planned_with_margin',
    });
    expect(diagnostic?.horizonPlan?.usesDeadlineReserve).toBe(false);
    expect(diagnostic?.horizonPlan?.deadlineMarginMs).toBe(HOUR_MS);
  });

  it('flips to at_risk when the plan has to allocate into the reserve hour', () => {
    // 4 kWh need at 1 kW with a 4-hour horizon (17:00 → 21:00): three primary
    // hours can carry 3 kWh, so the final hour (the reserve) must absorb the
    // remaining 1 kWh. That dip is exactly what at_risk should announce.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '21:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'at_risk' },
      reasonCode: 'planned_using_deadline_reserve',
    });
    expect(diagnostic?.horizonPlan?.usesDeadlineReserve).toBe(true);
    expect(diagnostic?.horizonPlan?.plannedUsefulEnergyKWh).toBeCloseTo(4);
    // Every earlier hour is fully booked at planning power: 3 hours × 1 kW.
    const reserveAllocated = sumReserveAllocation(diagnostic?.horizonPlan?.plannedBuckets ?? []);
    expect(reserveAllocated).toBeCloseTo(1);
  });

  it('reports at_risk (feasible_above_floor) when the floor misses but climbing fits', () => {
    // 4 kWh need with only a 3-hour horizon: at the guaranteed floor (low = 1 kW)
    // every hour — including the reserve hour at 19:00 → 20:00 — is fully booked
    // and 1 kWh stays unplanned. But this device can climb to high (2 kW), which
    // would fit the full 4 kWh, so the verdict is at_risk, not a flat cannot_meet
    // false negative. The floor commitment still leaves 1 kWh unplanned.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '20:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'at_risk' },
      reasonCode: 'feasible_above_floor',
    });
    expect(diagnostic?.horizonPlan?.unplannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('treats deadlines closer than the reserve window as fully inside the reserve', () => {
    // 30-minute horizon: reserve (1 h) is longer than time-to-deadline, so
    // every available minute is reserve. Any allocation flips at_risk; the
    // planner does not degrade to on_track just because no primary window
    // exists. 0.2 kWh fits in 0.5 h of reserve at 1 kW.
    const deadlineAtMs = NOW_MS + HOUR_MS / 2;
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({
        deadlineAtMs,
        targetPercent: 41,
      })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      trajectory: { kind: 'resolved', status: 'at_risk' },
      reasonCode: 'planned_using_deadline_reserve',
    });
    expect(diagnostic?.horizonPlan?.usesDeadlineReserve).toBe(true);
  });

  // ---------- Concurrent fully-reserved task headroom split (Slice 2 sibling) ----------
  // Two priority-1 fully-reserved smart tasks must not both promote their
  // committed floor to the same reserved-headroom forecast — they would
  // double-book the reserved slot in diagnostic verdicts. The producer splits
  // the headroom equally across the eligible-task count so two competing tasks
  // each see their fair fraction. These tests pin the verdict, not the
  // physical power delivery (the capacity guard handles the hard cap).
  describe('concurrent fully-reserved tasks consume capacity in deterministic priority order', () => {
    // Reusable shape: two EV-style devices, each needing 6 kWh in 4h. The min
    // step is 1 kW (4 kWh max → 2 kWh short on the floor) and the climbed step
    // (high = 2 kW × 4h = 8 kWh) fits. With promotion to `high` (2 kW), the
    // full 6 kWh lands inside the primary window plus reserve so the verdict
    // is `on_track`. Without promotion the floor is short and the climbed-band
    // probe softens to `at_risk: feasible_above_floor`.
    //
    // The horizon spans 5 hours (one deadline-reserve hour included). hardCap
    // = 5 kW with zero uncontrolled background gives 5 kW of reserved
    // headroom; the two-step EV ladder tops out at 2 kW, so a single fully-
    // reserved task always promotes to `high`. Splitting that 5 kW between
    // two competing tasks (2.5 kW each) still fits `high` (2 kW), so to make
    // the split observable we use a three-step ladder with a `top = 3 kW`
    // entry: 5 kW solo → promotes to top (3 kW × 4 = 12 kWh fits), 2.5 kW
    // split → top (3 kW) doesn't fit, only `mid` (2 kW) does, which still
    // delivers 8 kWh ≥ 6 kWh need → on_track. We need the split to actually
    // *fail* to promote past the floor for the verdict to flip, so we shrink
    // the hardCap so the split share falls below even `mid`.
    //
    // Final math: hardCap = 3 kW. Solo: reserved = 3 kW → promotes to `top`
    // (3 kW × 4 = 12 kWh; need 6 kWh) → on_track. Split=2: reserved = 1.5 kW
    // each → neither `mid` (2 kW) nor `top` (3 kW) fits → stays at min (1 kW)
    // → floor places 4 kWh, 2 kWh short → climbed probe (top 3 kW × 4 =
    // 12 kWh) fits → at_risk: feasible_above_floor.
    const HARDCAP_KW = 3;
    const NEED_KWH_TO_REACH = 6;
    const buildPromotableDevice = (id: string): PlanInputDevice => withMaterializedEvPlugState(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0,
      surplusTracking: false,
      id,
      name: id,
      targets: [],
      binaryControl: { on: false },
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_paused',
      priority: 1,
      stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: NOW_MS }),
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0, expectedPowerKw: 1 },
          { id: 'min', planningPowerW: 1000 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'top', planningPowerW: 3000 },
        ],
      },
      controllable: true,
      available: true,
    })) as PlanInputDevice;

    // Target = current + 30%, profile rate = 0.2 kWh/% → 30 × 0.2 = 6 kWh.
    const buildPromotableSettings = (
      deviceId: string,
      rescue?: Record<string, 'always' | 'at_risk'>,
    ) => ({
      [deviceId]: {
        enabled: true,
        kind: 'ev_soc' as const,
        enforcement: 'soft' as const,
        targetPercent: 40 + (NEED_KWH_TO_REACH / 0.2),
        deadlineAtMs: resolveDeadlineAtMsFor('22:00'), // NOW_MS = 17:00 → 5h horizon (4h primary + 1h reserve).
        ...(rescue ? { rescue } : {}),
      },
    });

    const buildPromotableTracker = (deviceIds: string[]): PowerTrackerState => ({
      objectiveProfiles: Object.fromEntries(deviceIds.map((id) => [id, {
        kind: 'ev_soc',
        updatedAtMs: NOW_MS,
        lastSample: { observedAtMs: NOW_MS, value: 40, unit: 'percent' },
        kwhPerUnit: {
          sampleCount: 4,
          mean: 0.2,
          m2: 0,
          min: 0.2,
          max: 0.2,
          confidence: 'medium',
          lastUpdatedMs: NOW_MS,
        },
        acceptedSamples: 4,
        rejectedSamples: 0,
      }])),
    });

    const fullyReservedRescue = {
      exemptFromBudget: 'always' as const,
      limitLowerPriorityDevices: 'always' as const,
    };

    // The default `allowedCumKWh` ramps by 1 kWh per bucket, which caps the
    // non-exempt floor allocation at 1 kWh/h regardless of the step. To
    // observe the headroom-split effect on the climbed-band verdict for the
    // *no-rescue* control, the per-bucket budget must not be the binding
    // constraint. The exempt rebuild lifts caps for the rescued task; this
    // generous schedule keeps the no-rescue task's per-bucket cap large too.
    const generousAllowedCumKWh = Array.from({ length: 24 }, (_, index) => (index + 1) * 100);

    it('a single priority-1 fully-reserved task promotes to the top step using the full reserved headroom', () => {
      // Solo control: full 3 kW headroom available → promotes to `top` (3 kW)
      // → 3 kW × 4 h primary = 12 kWh fits 6 kWh need → on_track.
      const [diagnostic] = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [buildPromotableDevice('ev-1')],
        settings: normalizeDeferredObjectiveSettings({
          version: 1,
          objectivesByDeviceId: {
            ...buildPromotableSettings('ev-1', fullyReservedRescue),
          },
        }),
        powerTracker: buildPromotableTracker(['ev-1']),
        dailyBudgetSnapshot: buildSnapshot({
          prices: Array.from({ length: 24 }, () => 5),
          allowedCumKWh: generousAllowedCumKWh,
          plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        }),
        priceOptimizationEnabled: true,
        hardCapKw: HARDCAP_KW,
      });
      expect(diagnostic).toMatchObject({
        trajectory: { kind: 'resolved', status: 'on_track' },
      });
    });

    it('grants a below-top-priority task the limit permission without promoting its floor', () => {
      // Guards the split the permission gate now relies on. The two questions are
      // separate: PERSISTING `limitLowerPriorityDevices` is useful at any priority
      // (swap selection only ever displaces strictly lower-priority devices), but
      // `fullyReserved` FLOOR PROMOTION stays priority-1-only, because the
      // reserved-headroom forecast (`hardCap − uncontrolled`) assumes every
      // controlled watt is displaceable — true only at the top.
      //
      // So a priority-2 task with both permissions must report the grant as
      // applied while planning at the un-promoted floor: `min` (1 kW) × 4 h = 4 kWh
      // against a 6 kWh need, versus the priority-1 control above which promotes to
      // `top` (3 kW) and reaches `on_track`.
      const higherDevice = { ...buildPromotableDevice('higher-device'), priority: 1 };
      const belowTop = { ...buildPromotableDevice('ev-1'), priority: 2 };
      const [diagnostic] = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [higherDevice, belowTop],
        settings: normalizeDeferredObjectiveSettings({
          version: 1,
          objectivesByDeviceId: {
            ...buildPromotableSettings('ev-1', fullyReservedRescue),
          },
        }),
        powerTracker: buildPromotableTracker(['ev-1']),
        dailyBudgetSnapshot: buildSnapshot({
          prices: Array.from({ length: 24 }, () => 5),
          allowedCumKWh: generousAllowedCumKWh,
          plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        }),
        priceOptimizationEnabled: true,
        hardCapKw: HARDCAP_KW,
      });
      // The permission is live for the planner's boost lane...
      expect(diagnostic.limitLowerPriorityApplied).toBe(true);
      // ...but the floor was NOT promoted, so the task cannot claim the top step.
      expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).not.toBe('on_track');
    });

    it('normalizes equal base priorities by device id without double-booking an hour', () => {
      const diagnostics = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [
          buildPromotableDevice('ev-1'),
          buildPromotableDevice('ev-2'),
        ],
        settings: normalizeDeferredObjectiveSettings({
          version: 1,
          objectivesByDeviceId: {
            ...buildPromotableSettings('ev-1', fullyReservedRescue),
            ...buildPromotableSettings('ev-2', fullyReservedRescue),
          },
        }),
        powerTracker: buildPromotableTracker(['ev-1', 'ev-2']),
        dailyBudgetSnapshot: buildSnapshot({
          prices: Array.from({ length: 24 }, () => 5),
          allowedCumKWh: generousAllowedCumKWh,
          plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        }),
        priceOptimizationEnabled: true,
        hardCapKw: HARDCAP_KW,
      });
      expect(diagnostics).toHaveLength(2);
      const byDevice = new Map(diagnostics.map((diagnostic) => [diagnostic.deviceId, diagnostic]));
      expect(resolvedTrajectoryStatus(byDevice.get('ev-1')!)).toBe('on_track');
      expect(byDevice.get('ev-1')?.devicePriority).toBe(1);
      expect(byDevice.get('ev-2')).toMatchObject({
        devicePriority: 2,
        trajectory: { kind: 'resolved', status: 'at_risk' },
      });
      const firstHours = new Set(byDevice.get('ev-1')?.horizonPlan?.plannedBuckets
        .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
        .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS));
      const secondHours = byDevice.get('ev-2')?.horizonPlan?.plannedBuckets
        .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
        .map((bucket) => Math.floor(bucket.startMs / HOUR_MS) * HOUR_MS) ?? [];
      expect(secondHours.every((hour) => !firstHours.has(hour))).toBe(true);
    });

    it('counts only the eligible task when only one of two priority-1 tasks holds both rescue permissions', () => {
      // ev-1 holds both rescue permissions → eligible. ev-2 has rescue absent
      // (the no-rescue case) → not eligible. The producer's eligible count
      // is therefore 1, so ev-1 sees the full 3 kW headroom and promotes to
      // `top` → on_track. ev-2 falls outside the fully-reserved path entirely
      // and stays on the min-step floor: 4 kWh placed of 6 kWh need →
      // climbed-band probe softens to `at_risk: feasible_above_floor`.
      const diagnostics = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [
          buildPromotableDevice('ev-1'),
          buildPromotableDevice('ev-2'),
        ],
        settings: normalizeDeferredObjectiveSettings({
          version: 1,
          objectivesByDeviceId: {
            ...buildPromotableSettings('ev-1', fullyReservedRescue),
            ...buildPromotableSettings('ev-2'),
          },
        }),
        powerTracker: buildPromotableTracker(['ev-1', 'ev-2']),
        dailyBudgetSnapshot: buildSnapshot({
          prices: Array.from({ length: 24 }, () => 5),
          allowedCumKWh: generousAllowedCumKWh,
          plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        }),
        priceOptimizationEnabled: true,
        hardCapKw: HARDCAP_KW,
      });
      const byDevice = new Map(diagnostics.map((d) => [d.deviceId, d]));
      expect(byDevice.get('ev-1')).toMatchObject({ trajectory: { kind: 'resolved', status: 'on_track' } });
      expect(byDevice.get('ev-2')).toMatchObject({
        trajectory: { kind: 'resolved', status: 'at_risk' },
        reasonCode: 'feasible_above_floor',
      });
    });

    it('does not promote a lower relative rank after a higher task carries a prior commitment', () => {
      const deadlineAtMs = resolveDeadlineAtMsFor('22:00');
      // Mirror the prior-cycle commitment shape that `activePlanRecorder`
      // would persist for a fully-reserved top-priority EV: a 5-hour
      // schedule at the (then-current) min-step floor. The exact hour
      // values don't matter to the eligibility filter — what matters is
      // that `resolveCommittedHours` returns a non-undefined commitment
      // (kind/deadline/signature all match the live objective) so the
      // committed-replan path actually engages.
      const committedHours = Array.from({ length: 5 }, (_, index) => ({
        startsAtMs: NOW_MS + index * HOUR_MS,
        plannedKWh: 1,
      }));
      // Signature must match `buildObjectiveSignature` for the live
      // objective, otherwise `resolveCommittedHours` returns undefined and
      // the test silently degrades to two fresh tasks. The objective uses
      // `fullyReservedRescue`, so the signature's rescue tail is present.
      const objectiveSignature = JSON.stringify([
        'ev_soc',
        null,
        40 + (NEED_KWH_TO_REACH / 0.2),
        deadlineAtMs,
        'soft',
        ['rescue', 'always', 'always'],
      ]);
      const activePlans: DeferredObjectiveActivePlansV1 = {
        version: 1,
        plansByDeviceId: {
          'ev-1': {
            deviceId: 'ev-1',
            deviceName: 'ev-1',
            objectiveKind: 'ev_soc',
            targetTemperatureC: null,
            targetPercent: 40 + (NEED_KWH_TO_REACH / 0.2),
            deadlineAtMs,
            startedAtMs: NOW_MS - HOUR_MS,
            pending: false,
            objectiveSignature,
            commitment: {
              committedAtMs: NOW_MS - HOUR_MS,
              hours: committedHours,
            },
            original: {
              revision: 1,
              revisedAtMs: NOW_MS - HOUR_MS,
              computedFromPricesUpTo: NOW_MS + 24 * HOUR_MS,
              reason: 'flow_card',
              hours: committedHours,
              energyNeededKWh: NEED_KWH_TO_REACH,
              planStatus: 'at_risk',
            },
            latest: {
              revision: 1,
              revisedAtMs: NOW_MS - HOUR_MS,
              computedFromPricesUpTo: NOW_MS + 24 * HOUR_MS,
              reason: 'flow_card',
              hours: committedHours,
              energyNeededKWh: NEED_KWH_TO_REACH,
              planStatus: 'at_risk',
            },
          },
        },
      };
      const diagnostics = buildDeferredObjectiveDiagnostics({
        nowMs: NOW_MS,
        timeZone: 'UTC',
        devices: [
          buildPromotableDevice('ev-1'),
          buildPromotableDevice('ev-2'),
        ],
        settings: normalizeDeferredObjectiveSettings({
          version: 1,
          objectivesByDeviceId: {
            ...buildPromotableSettings('ev-1', fullyReservedRescue),
            ...buildPromotableSettings('ev-2', fullyReservedRescue),
          },
        }),
        powerTracker: buildPromotableTracker(['ev-1', 'ev-2']),
        dailyBudgetSnapshot: buildSnapshot({
          prices: Array.from({ length: 24 }, () => 5),
          allowedCumKWh: generousAllowedCumKWh,
          plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
        }),
        priceOptimizationEnabled: true,
        hardCapKw: HARDCAP_KW,
        activePlans,
      });
      expect(diagnostics).toHaveLength(2);
      const byDevice = new Map(diagnostics.map((d) => [d.deviceId, d]));
      // `at_risk`, not `cannot_meet`: ev-1's commitment reserves 1 kW of the 3 kW
      // cap, leaving ev-2 a genuine 2 kW of forecast headroom — enough at the `mid`
      // rung to cover its 6 kWh over the four primary hours. It is short at its
      // FLOOR, which is what the rest of this test is about, but it is not beyond
      // reach. (This read `cannot_meet` while both feasibility probes ran at the
      // absolute `top` rung: 3 kW exceeds ev-2's 2 kW headroom, so the capacity gate
      // zeroed every bucket and both probes reported "does not fit" no matter what.)
      expect(byDevice.get('ev-2')).toMatchObject({
        devicePriority: 2,
        trajectory: { kind: 'resolved', status: 'at_risk' },
      });
      expect(byDevice.get('ev-1')?.expectedStepId).toBe('min');
      expect(byDevice.get('ev-2')?.horizonPlan?.plannedBuckets
        .filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
        .every((bucket) => bucket.plannedAdmissionPowerKw === 1)).toBe(true);
    });
  });
});

describe('buildDeferredObjectiveDiagnostics — stall-classification status resolution', () => {
  // on_track recipe: 4 kWh need fits the 17:00→22:00 window with reserve intact.
  const onTrackParams = () => ({
    nowMs: NOW_MS,
    timeZone: 'UTC',
    devices: [buildDevice()],
    settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' })),
    powerTracker: buildPowerTracker(),
    dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
    priceOptimizationEnabled: true,
  });

  // at_risk recipe: cumulative daily budget plateaus at the 20 kWh cap, so the
  // horizon is budget-bound (mirrors the dailyBudgetExhaustedBucketCount test).
  const atRiskParams = () => ({
    nowMs: NOW_MS,
    timeZone: 'UTC',
    devices: [buildDevice()],
    settings: normalizeDeferredObjectiveSettings(buildSettings()),
    powerTracker: buildPowerTracker(),
    dailyBudgetSnapshot: buildSnapshot({
      prices: Array.from({ length: 24 }, () => 5),
      allowedCumKWh: Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20)),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
    }),
    priceOptimizationEnabled: true,
  });

  // An established run = the active-plan recorder has committed a `latest`
  // revision for this (device, deadline). Stall resolution is suppressed until
  // then so a first-seen task can't read a stale device-keyed classifier verdict.
  const establishedPlans = (deadlineAtMs: number): DeferredObjectiveActivePlansV1 => ({
    version: 1,
    plansByDeviceId: {
      'ev-1': {
        deviceId: 'ev-1',
        deviceName: 'Driveway EV',
        objectiveKind: 'ev_soc',
        targetTemperatureC: null,
        targetPercent: 60,
        deadlineAtMs,
        startedAtMs: NOW_MS - HOUR_MS,
        pending: false,
        objectiveSignature: JSON.stringify(['ev_soc', null, 60, deadlineAtMs, 'soft']),
        original: null,
        latest: {
          revision: 1,
          revisedAtMs: NOW_MS - HOUR_MS,
          computedFromPricesUpTo: NOW_MS + HOUR_MS,
          reason: 'flow_card',
          hours: [],
          energyNeededKWh: 2,
          planStatus: 'on_track',
        },
      },
    },
  });

  // Build once to read the resolved deadline, then attach a matching established
  // plan so the first-seen guard is satisfied for the resolution-path tests.
  const withEstablishedPlan = (params: ReturnType<typeof onTrackParams>) => {
    const deadlineAtMs = buildDeferredObjectiveDiagnostics(params)[0]?.deadlineAtMs;
    if (deadlineAtMs == null) throw new Error('expected a resolved deadline');
    return { ...params, activePlans: establishedPlans(deadlineAtMs) };
  };

  it('marks an on_track task with the left-off cause without rewriting its status', () => {
    // An explicit off action beats the task, but the task must not keep claiming
    // it is on track just because future hours are still scheduled — those hours
    // cannot run while the device stays off.
    const [before] = buildDeferredObjectiveDiagnostics(onTrackParams());
    expect(before?.externalOffHoldActive).toBeUndefined();

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...onTrackParams(),
      devices: [buildDevice({ externalOffHoldActive: true })],
    });
    expect(diagnostic?.externalOffHoldActive).toBe(true);
    // The planner's own verdict is untouched: it is frozen into the committed
    // revision (it resolves `floorShortfallCause`), so overwriting it would
    // erase a budget-bound task's real cause the moment the hold spans a settle.
    expect(diagnostic?.reasonCode).toBe(before?.reasonCode);
    // `status` is what the recorder FREEZES into a committed revision at the
    // settle. Rewriting it here would outlive the hold: turning the device back
    // on clears the live cause, but the frozen verdict would keep every surface
    // reporting risk for up to an hour. Consumers overlay it per cycle instead
    // (`resolveEffectivePlanStatus`), which is live in both directions.
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('on_track');
    expect(diagnostic?.horizonPlan?.status).toBe('on_track');
  });

  it('carries the hold through a diagnostic data gap', () => {
    // Stale temperature/SoC, capacity, or charge-step data degrades the live
    // verdict to `unknown`. Dropping the flag there cleared the cause on the
    // committed plan, so every surface reverted to the cached `on_track` while
    // the device was still held off — and no status-change event fired, possibly
    // for the whole outage. A data gap is not the user turning the device on.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...onTrackParams(),
      // A stale SoC reading is one of the data gaps that degrades the live
      // verdict; the committed plan and the hold are both unaffected by it.
      devices: [buildDevice({
        externalOffHoldActive: true,
        stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: NOW_MS - 86_400_000, unavailable: 'not_reported' }),
      })],
    });
    // Guard the guard: if this ever stops degrading the live verdict, the case
    // is no longer being exercised and the assertion below means nothing.
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBeUndefined();
    expect(diagnostic?.externalOffHoldActive).toBe(true);
  });

  // Flagged independently by the runtime-reality lens and by Codex on #2182.
  // An earlier revision suppressed this on `!isCommandableNow`, which is false
  // for a merely unavailable device — so a thermostat the owner had turned off
  // outside PELS would drop `externalOffHoldActive` on one flaky SDK read,
  // `resolveDiagnosticReasonCode` would clear the persisted
  // `objective_device_left_off`, and every surface would revert to a cached
  // "On track" while the device was still held off. The suppression is scoped to
  // the SESSION question, which is `false` for every non-EV device.
  it('keeps the external-off hold on a non-EV device that is merely unavailable', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      // `commandableNow: false` mirrors what the producer emits for an
      // unavailable device — the exact state the earlier gate tripped on.
      devices: [buildTemperatureDevice({
        externalOffHoldActive: true, available: false, commandableNow: false,
      })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 30) }),
      priceOptimizationEnabled: true,
    });
    expect(diagnostic?.externalOffHoldActive).toBe(true);
  });

  it('keeps the unplugged reason for a held charger that is also unplugged', () => {
    // "Paused — unplugged" is the more immediate thing for the user to act on;
    // the hold is still stored and reappears once the car is reconnected.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...onTrackParams(),
      devices: [buildDevice({ externalOffHoldActive: true, evChargingState: 'plugged_out' })],
    });
    expect(diagnostic?.externalOffHoldActive).toBeUndefined();
  });

  // Regression, prod 2026-08-19/20: an EV smart task on a charger with no car
  // plugged in reported `objective_progress_stale` — a READING problem — for two
  // full 10-hour task windows, 2354 log lines, and finalized `abandoned`. The
  // precondition test that should have caught it read `device.evChargingState`,
  // which `toPlanDevice` strips, so it was dead code: `objective_invalid_session`
  // had never once been emitted in production. The fixture keeps a KNOWN
  // state-of-charge on purpose — the reading was fine, the session was not, and
  // reading availability must not be what answers this question.
  it('reports an unplugged charger as no session, not a stale reading', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...onTrackParams(),
      devices: [buildDevice({ evChargingState: 'plugged_out' })],
    });
    expect(diagnostic?.reasonCode).toBe('objective_invalid_session');
    expect(diagnostic?.currentPercent).toBeNull();
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBeUndefined();
  });

  // The session question is asked of the plug-state alone, NOT of
  // `commandableNow` — which also goes false for `available === false` and for
  // PELS's own binary-command retry back-off. Folding those in would render
  // "EV is unplugged — plug in to resume." at an owner whose car is plugged in
  // and charging, and would drop the committed plan on one flaky SDK read.
  it('does not call an unavailable charger unplugged', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...onTrackParams(),
      devices: [buildDevice({ available: false })],
    });
    expect(diagnostic?.reasonCode).not.toBe('objective_invalid_session');
  });

  it('leaves the trajectory status untouched when no stall reader is supplied', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics(onTrackParams());
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('on_track');
  });

  it('resolves a parked on_track device to satisfied with the near-target reason, preserving the raw status', () => {
    const params = withEstablishedPlan(onTrackParams());
    expect(resolvedTrajectoryStatus(buildDeferredObjectiveDiagnostics(params)[0])).toBe('on_track');

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...params,
      getStallClassification: (id: string) => (id === 'ev-1'
        ? { classification: 'near_target_idle' as const, classifiedAgainstTargetValue: 60 }
        : undefined),
    });
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('satisfied');
    expect(diagnostic?.reasonCode).toBe('objective_stalled_near_target');
    expect(diagnostic?.actuationSatisfied).toBe(false);
    // The raw trajectory verdict stays on the horizonPlan so the postmortem
    // recorder and the structured horizon log keep the honest reading.
    expect(diagnostic?.horizonPlan?.status).toBe('on_track');
  });

  it('resolves a parked failing device (at_risk) to satisfied with the device-capped reason', () => {
    const params = withEstablishedPlan(atRiskParams());
    expect(resolvedTrajectoryStatus(buildDeferredObjectiveDiagnostics(params)[0])).toBe('at_risk');

    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...params,
      getStallClassification: () => ({ classification: 'capped_idle' as const, classifiedAgainstTargetValue: 60 }),
    });
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('satisfied');
    expect(diagnostic?.reasonCode).toBe('objective_stalled_device_capped');
    expect(diagnostic?.actuationSatisfied).toBe(false);
    expect(diagnostic?.horizonPlan?.status).toBe('at_risk');
  });

  it('never treats an unresponsive (likely-fault) device as satisfied', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...withEstablishedPlan(atRiskParams()),
      getStallClassification: () => ({ classification: 'unresponsive' as const, classifiedAgainstTargetValue: 60 }),
    });
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('at_risk');
  });

  it('ignores a stale classifier verdict on a first-seen task (no established plan yet)', () => {
    // No activePlans → the run is first-seen, so the device-keyed classifier
    // result belongs to a prior objective and must NOT promote this brand-new
    // task to satisfied. Regression guard for the stale-classifier window.
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      ...atRiskParams(),
      getStallClassification: () => ({ classification: 'near_target_idle' as const, classifiedAgainstTargetValue: 60 }),
    });
    expect(diagnostic && resolvedTrajectoryStatus(diagnostic)).toBe('at_risk');
  });
});

// One prod night emitted 1199 identical `deferred_objective_unknown` lines for a
// single charger whose car was not plugged in. A cause with no trajectory is
// worth stating once; a resolved trajectory carries a live horizon and is new
// information every tick.
describe('emitDeferredObjectiveDiagnostics — a stuck cause announces once', () => {
  // 30 s apart, mirroring the lifecycle clock.
  const TICK_MS = 30_000;
  const emitAll = (
    diagnostics: DeferredObjectiveDiagnostic[],
    ticks: number,
  ): Record<string, unknown>[] => {
    const emitted: Record<string, unknown>[] = [];
    let announced: ReadonlyMap<string, DeferredObjectiveUnknownAnnounce> = new Map();
    for (let tick = 0; tick < ticks; tick += 1) {
      announced = emitDeferredObjectiveDiagnostics({
        diagnostics,
        debugStructured: (payload) => { emitted.push(payload); },
        nowMs: NOW_MS + tick * TICK_MS,
        announcedUnknownCauses: announced,
      });
    }
    return emitted;
  };

  const unpluggedDiagnostics = (): DeferredObjectiveDiagnostic[] => buildDeferredObjectiveDiagnostics({
    nowMs: NOW_MS,
    timeZone: 'UTC',
    devices: [buildDevice({ evChargingState: 'plugged_out' })],
    settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' })),
    powerTracker: buildPowerTracker(),
    dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
    priceOptimizationEnabled: true,
  });

  it('emits one unknown payload across many ticks of the same cause', () => {
    const diagnostics = unpluggedDiagnostics();
    expect(diagnostics[0]?.reasonCode).toBe('objective_invalid_session');

    const emitted = emitAll(diagnostics, 20);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe('deferred_objective_unknown');
    expect(emitted[0]?.reasonCode).toBe('objective_invalid_session');
  });

  it('re-announces when the cause changes', () => {
    let announced: ReadonlyMap<string, DeferredObjectiveUnknownAnnounce> = new Map();
    const emitted: Record<string, unknown>[] = [];
    const collect = (payload: Record<string, unknown>): void => { emitted.push(payload); };

    const unplugged = unpluggedDiagnostics();
    announced = emitDeferredObjectiveDiagnostics({
      diagnostics: unplugged, debugStructured: collect, nowMs: NOW_MS, announcedUnknownCauses: announced,
    });
    const stale = unplugged.map((diagnostic) => ({
      ...diagnostic,
      trajectory: { kind: 'unavailable' as const, reasonCode: 'objective_progress_stale' as const },
    }));
    emitDeferredObjectiveDiagnostics({
      diagnostics: stale, debugStructured: collect, nowMs: NOW_MS + TICK_MS, announcedUnknownCauses: announced,
    });

    expect(emitted).toHaveLength(2);
  });

  // The unavailable payload is not constant: the external-off hold moves
  // independently of the cause, so suppressing on the cause alone would hide the
  // owner turning the device off outside PELS behind an unchanged reason code.
  it('re-announces when a payload bit moves under an unchanged cause', () => {
    let announced: ReadonlyMap<string, DeferredObjectiveUnknownAnnounce> = new Map();
    const emitted: Record<string, unknown>[] = [];
    const collect = (payload: Record<string, unknown>): void => { emitted.push(payload); };

    const base = unpluggedDiagnostics();
    announced = emitDeferredObjectiveDiagnostics({
      diagnostics: base, debugStructured: collect, nowMs: NOW_MS, announcedUnknownCauses: announced,
    });
    const held = base.map((diagnostic) => ({ ...diagnostic, externalOffHoldActive: true as const }));
    emitDeferredObjectiveDiagnostics({
      diagnostics: held, debugStructured: collect, nowMs: NOW_MS + TICK_MS, announcedUnknownCauses: announced,
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.externalOffHoldActive).toBe(true);
  });

  // Without this an all-night stall is one line at 22:00, and an operator cannot
  // tell "still stuck at 06:00" from "silently resolved".
  it('re-announces hourly with the suppressed-tick count', () => {
    const diagnostics = unpluggedDiagnostics();
    // 30 s ticks across just over two hours.
    const emitted = emitAll(diagnostics, 245);
    expect(emitted).toHaveLength(3);
    expect(emitted[0]?.suppressedTicks).toBeUndefined();
    expect(emitted[1]?.suppressedTicks).toBe(119);
    expect(emitted[2]?.suppressedTicks).toBe(119);
  });

  it('never suppresses a resolved trajectory — its horizon is new each tick', () => {
    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ deadlineLocalTime: '22:00' })),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    });
    expect(resolvedTrajectoryStatus(diagnostics[0]!)).toBe('on_track');
    expect(emitAll(diagnostics, 5)).toHaveLength(5);
  });
});
