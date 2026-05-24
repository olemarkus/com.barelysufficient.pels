import {
  buildDeferredObjectiveDiagnostics,
  buildDeferredObjectivePolicyHorizon,
  ConcurrentEligibleTaskTracker,
  createEmptyDeferredObjectiveSettings,
  ELIGIBILITY_ABANDON_GRACE_MS,
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
} from '../lib/plan/deferredObjectives';
import type {
  DeferredObjectivePlannedBucket,
} from '../lib/plan/deferredObjectives';
import { buildDeferredObjectiveDebugPayload } from '../lib/plan/deferredObjectives/diagnosticDebugPayload';
import { DeferredObjectivePlanHistoryRecorder } from '../lib/plan/deferredObjectives/planHistory';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../lib/power/tracker';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import type { DeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanHistoryV4 } from '../packages/contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 17, 0, 0);

const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'ev-1',
  name: 'Driveway EV',
  targets: [],
  currentOn: false,
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  evChargingState: 'plugged_in_paused',
  stateOfCharge: {
    percent: 40,
    status: 'fresh',
    observedAtMs: NOW_MS,
  },
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1000 },
      { id: 'high', planningPowerW: 2000 },
    ],
  },
  ...overrides,
});

const buildTemperatureDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'heater-1',
  name: 'Connected 300',
  targets: [{ id: 'target_temperature', value: 55, unit: 'C', min: 0, max: 95, step: 0.5 }],
  currentOn: false,
  deviceType: 'temperature',
  controlModel: 'stepped_load',
  currentTemperature: 55,
  lastFreshDataMs: NOW_MS,
  steppedLoadProfile: {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'heat', planningPowerW: 3000 },
    ],
  },
  ...overrides,
});

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
  saved: () => DeferredObjectivePlanHistoryV4 | null;
} => {
  let saved: DeferredObjectivePlanHistoryV4 | null = null;
  return {
    recorder: new DeferredObjectivePlanHistoryRecorder({
      load: () => null,
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
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, index) => `${String(index).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: Array.from({ length: 24 }, () => 1),
      actualKWh: Array.from({ length: 24 }, () => 0),
      allowedCumKWh: params.allowedCumKWh ?? Array.from({ length: 24 }, (_, index) => index + 1),
      price: prices,
      ...(params.plannedUncontrolledKWh ? { plannedUncontrolledKWh: params.plannedUncontrolledKWh } : {}),
      ...(params.includePriceFactor === false
        ? {}
        : { priceFactor: prices.map((price) => (price <= 10 ? 1.2 : 0.8)) }),
    },
  };
};

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
  it('marks expensive raw-price buckets as avoid when price factors are unavailable', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        includePriceFactor: false,
        prices: Array.from({ length: 24 }, (_, index) => (index === 18 ? 100 : 10)),
      }),
    });

    expect(result.reasonCode).toBeNull();
    expect(result.buckets.map((bucket) => bucket.preference)).toContain('avoid');
  });

  it('sets per-bucket maxUsefulEnergyKWh from per-bucket budget minus uncontrolled forecast', () => {
    // allowedCumKWh advances by 3 kWh per bucket → 3 kWh budget per hour.
    // plannedUncontrolledKWh = 0.5 per hour → 2.5 kWh headroom per bucket.
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => (index + 1) * 3),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
    });
    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBeCloseTo(2.5);
    }
  });

  it('clamps the per-bucket cap to zero when uncontrolled forecast exceeds the per-bucket budget', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => index + 1),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 5),
      }),
    });
    expect(result.reasonCode).toBeNull();
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBe(0);
    }
  });

  it('omits the per-bucket cap when uncontrolled forecast is missing (legacy snapshot)', () => {
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

  it('counts buckets whose per-bucket cap collapsed because the daily budget is exhausted', () => {
    // dailyBudgetKWh defaults to 20. allowedCumKWh plateaus at 20 from index 9
    // onwards, simulating `buildAllowedCumKWh` clamping the cumulative once it
    // reaches the cap. NOW_MS is hour 17 UTC, so all four buckets in the
    // horizon (17–20) sit on the plateau and the diagnostic should be able to
    // explain that the daily budget cap — not background load — caused the
    // zero capacity.
    const plateauedAllowed = Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20));
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        allowedCumKWh: plateauedAllowed,
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
    });
    expect(result.reasonCode).toBeNull();
    expect(result.dailyBudgetExhaustedBucketCount).toBe(4);
    for (const bucket of result.buckets) {
      expect(bucket.maxUsefulEnergyKWh).toBe(0);
    }
  });

  it('lifts the per-bucket cap entirely when exempt from budget, even on an exhausted budget', () => {
    // Same budget-exhausted plateau as the exhaustion test (caps collapse to 0), but with
    // exemptFromBudget the daily-budget per-bucket cap is removed so the device can plan
    // against step capacity. The physical hard cap stays enforced downstream.
    const plateauedAllowed = Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20));
    const snapshot = {
      allowedCumKWh: plateauedAllowed,
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

  it('does not flag exhaustion when the per-bucket cap is non-zero', () => {
    const result = buildDeferredObjectivePolicyHorizon({
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        allowedCumKWh: Array.from({ length: 24 }, (_, index) => (index + 1) * 3),
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
    });
    expect(result.reasonCode).toBeNull();
    expect(result.dailyBudgetExhaustedBucketCount).toBe(0);
  });

  // Regression: when two priority-1 fully-reserved smart tasks share a cycle they
  // were both able to promote their committed floor to the same per-bucket
  // `reservedHeadroomKw = hardCap - uncontrolled` forecast, double-booking the
  // reserved slot in diagnostic verdicts. The producer now divides the headroom
  // equally across the eligible-task count so each task sees its fair fraction.
  it('divides reservedHeadroomKw equally across concurrent eligible tasks (equal-share allocation)', () => {
    const base = {
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
      hardCapKw: 10,
    };
    const single = buildDeferredObjectivePolicyHorizon({ ...base, concurrentEligibleCount: 1 });
    const split = buildDeferredObjectivePolicyHorizon({ ...base, concurrentEligibleCount: 2 });
    expect(single.reasonCode).toBeNull();
    expect(split.reasonCode).toBeNull();
    for (const bucket of single.buckets) {
      // hardCap (10) - uncontrolled (0.5) = 9.5 kW available to a sole eligible task.
      expect(bucket.reservedHeadroomKw).toBeCloseTo(9.5);
    }
    for (const bucket of split.buckets) {
      // Same 9.5 kW now split between two eligible tasks → 4.75 kW each.
      expect(bucket.reservedHeadroomKw).toBeCloseTo(4.75);
    }
  });

  it('falls back to single-task headroom when concurrentEligibleCount is omitted, zero, or non-finite', () => {
    // Mis-passing a zero/NaN count must not produce Infinity/NaN headroom. The
    // resolver treats anything `< 1` or non-finite as `1`, preserving legacy
    // single-task behavior for all current callers that omit the parameter.
    const base = {
      nowMs: NOW_MS,
      deadlineAtMs: NOW_MS + 4 * HOUR_MS,
      priceOptimizationEnabled: true,
      dailyBudgetSnapshot: buildSnapshot({
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0.5),
      }),
      hardCapKw: 10,
    };
    const omitted = buildDeferredObjectivePolicyHorizon(base);
    const zero = buildDeferredObjectivePolicyHorizon({ ...base, concurrentEligibleCount: 0 });
    const negative = buildDeferredObjectivePolicyHorizon({ ...base, concurrentEligibleCount: -3 });
    const nan = buildDeferredObjectivePolicyHorizon({ ...base, concurrentEligibleCount: Number.NaN });
    for (const result of [omitted, zero, negative, nan]) {
      expect(result.reasonCode).toBeNull();
      for (const bucket of result.buckets) {
        expect(bucket.reservedHeadroomKw).toBeCloseTo(9.5);
      }
    }
  });
});

describe('ConcurrentEligibleTaskTracker', () => {
  // Build a minimal device + settings entry that satisfies the eligibility
  // predicate (priority 1, both rescue permissions `'always'`, enabled
  // objective). Each helper creates one task; the per-test code stitches them
  // into a settings map and device map.
  const buildEligibleDevice = (id: string): PlanInputDevice => ({
    id,
    name: id,
    targets: [],
    currentOn: false,
    deviceClass: 'evcharger',
    controlCapabilityId: 'evcharger_charging',
    evChargingState: 'plugged_in_paused',
    priority: 1,
    stateOfCharge: {
      percent: 40,
      status: 'fresh',
      observedAtMs: NOW_MS,
    },
    steppedLoadProfile: {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'low', planningPowerW: 1000 },
      ],
    },
  });

  const buildEligibleObjective = (deadlineAtMs: number) => ({
    enabled: true,
    kind: 'ev_soc' as const,
    enforcement: 'soft' as const,
    targetPercent: 60,
    deadlineAtMs,
    rescue: {
      exemptFromBudget: 'always' as const,
      limitLowerPriorityDevices: 'always' as const,
    },
  });

  it('keeps the count steady across a one-cycle device-snapshot eviction within the grace window', () => {
    // Regression for "Eligibility-count flicker hardening" TODO. A transient
    // SDK miss drops a device from `deviceById` for one cycle; without the
    // tracker the count flips N → N-1 → N and survivor diagnostics oscillate
    // `on_track` ↔ `at_risk: feasible_above_floor`. With the tracker the
    // count stays N for the entire grace window.
    const tracker = new ConcurrentEligibleTaskTracker();
    const deviceA = buildEligibleDevice('ev-A');
    const deviceB = buildEligibleDevice('ev-B');
    const deadlineAtMs = NOW_MS + 4 * HOUR_MS;
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-A': buildEligibleObjective(deadlineAtMs),
        'ev-B': buildEligibleObjective(deadlineAtMs),
      },
    });
    const bothPresent = new Map([
      [deviceA.id, deviceA],
      [deviceB.id, deviceB],
    ]);
    const onlyAPresent = new Map([[deviceA.id, deviceA]]);

    // Cycle 0: both observed → count = 2.
    tracker.observe({ settings, deviceById: bothPresent, nowMs: NOW_MS });
    expect(tracker.count({ nowMs: NOW_MS })).toBe(2);

    // Cycle 1: B disappears (transient SDK miss). The count must stay 2
    // while we wait out the grace window.
    const oneCycleLaterMs = NOW_MS + 30 * 1000;
    tracker.observe({ settings, deviceById: onlyAPresent, nowMs: oneCycleLaterMs });
    expect(tracker.count({ nowMs: oneCycleLaterMs })).toBe(2);

    // Cycle 2: B recovers before the grace window elapses.
    const twoCyclesLaterMs = NOW_MS + 60 * 1000;
    tracker.observe({ settings, deviceById: bothPresent, nowMs: twoCyclesLaterMs });
    expect(tracker.count({ nowMs: twoCyclesLaterMs })).toBe(2);
  });

  it('drops a task from the count after it has been absent beyond the grace window', () => {
    // Sibling to the flicker test: a device genuinely removed (config
    // disabled, hardware unplugged for hours, etc.) must eventually leave
    // the denominator so the surviving task gets its rightful undivided
    // headroom. The grace window is one ABANDON_GRACE_MS interval, identical
    // shape to `planHistory.ts`'s ABANDON_GRACE_MS so the two pieces of
    // grace bookkeeping stay easy to reason about together.
    const tracker = new ConcurrentEligibleTaskTracker();
    const deviceA = buildEligibleDevice('ev-A');
    const deviceB = buildEligibleDevice('ev-B');
    const deadlineAtMs = NOW_MS + 4 * HOUR_MS;
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-A': buildEligibleObjective(deadlineAtMs),
        'ev-B': buildEligibleObjective(deadlineAtMs),
      },
    });
    const bothPresent = new Map([
      [deviceA.id, deviceA],
      [deviceB.id, deviceB],
    ]);
    const onlyAPresent = new Map([[deviceA.id, deviceA]]);

    // Cycle 0: both observed.
    tracker.observe({ settings, deviceById: bothPresent, nowMs: NOW_MS });
    expect(tracker.count({ nowMs: NOW_MS })).toBe(2);

    // Cycle 1: B disappears for a long time. After one full grace window,
    // the next observe-with-B-absent must drop B from the count.
    const pastGraceMs = NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS;
    tracker.observe({ settings, deviceById: onlyAPresent, nowMs: pastGraceMs });
    expect(tracker.count({ nowMs: pastGraceMs })).toBe(1);
  });

  it('drops a task from the per-bucket count once its deadline has passed', () => {
    // Regression for "over-counts in late-horizon buckets" TODO. Two
    // priority-1 fully-reserved tasks share the horizon; A's deadline sits
    // at bucket[10] while B's deadline sits at bucket[20]. In bucket[5]
    // both are eligible (count = 2). By bucket[15] A has passed its
    // deadline and B should not still be sharing headroom with it
    // (count = 1).
    const tracker = new ConcurrentEligibleTaskTracker();
    const deviceA = buildEligibleDevice('ev-A');
    const deviceB = buildEligibleDevice('ev-B');
    const aDeadlineMs = NOW_MS + 10 * HOUR_MS;
    const bDeadlineMs = NOW_MS + 20 * HOUR_MS;
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-A': buildEligibleObjective(aDeadlineMs),
        'ev-B': buildEligibleObjective(bDeadlineMs),
      },
    });
    const deviceById = new Map([
      [deviceA.id, deviceA],
      [deviceB.id, deviceB],
    ]);

    tracker.observe({ settings, deviceById, nowMs: NOW_MS });

    const earlyBucketStartMs = NOW_MS + 5 * HOUR_MS;
    const lateBucketStartMs = NOW_MS + 15 * HOUR_MS;
    // Early bucket sits before either deadline → both tasks share.
    expect(tracker.count({ nowMs: NOW_MS, bucketStartMs: earlyBucketStartMs })).toBe(2);
    // Late bucket sits after A's deadline → only B remains in the
    // denominator. Without the per-bucket filter this would return 2 and
    // B's diagnostic would under-promote its committed floor on late
    // buckets that A can no longer claim.
    expect(tracker.count({ nowMs: NOW_MS, bucketStartMs: lateBucketStartMs })).toBe(1);
  });

  it('preserves the legacy whole-horizon count when bucketStartMs is omitted', () => {
    // Callers that don't care about per-bucket precision (legacy paths,
    // tests, the diagnostic-aggregate count) still get the simple
    // "everyone within grace" count.
    const tracker = new ConcurrentEligibleTaskTracker();
    const deviceA = buildEligibleDevice('ev-A');
    const deviceB = buildEligibleDevice('ev-B');
    const aDeadlineMs = NOW_MS + 10 * HOUR_MS;
    const bDeadlineMs = NOW_MS + 20 * HOUR_MS;
    const settings = normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-A': buildEligibleObjective(aDeadlineMs),
        'ev-B': buildEligibleObjective(bDeadlineMs),
      },
    });
    const deviceById = new Map([
      [deviceA.id, deviceA],
      [deviceB.id, deviceB],
    ]);
    tracker.observe({ settings, deviceById, nowMs: NOW_MS });
    expect(tracker.count({ nowMs: NOW_MS })).toBe(2);
  });
});

describe('buildDeferredObjectiveDiagnostics', () => {
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
      status: 'on_track',
      reasonCode: 'planned_with_margin',
      currentPercent: 40,
      targetPercent: 60,
      energyNeededKWh: 4,
      kWhPerPercent: 0.2,
      requestedMinimumStepId: 'low',
      horizonBucketCount: 5,
    });
    expect(diagnostic?.horizonPlan?.plannedBuckets.some((bucket) => bucket.preference === 'preferred')).toBe(true);
  });

  it('reports zero budget-exhausted buckets for an exempt-from-budget task on an exhausted budget', () => {
    // NOW_MS is 17:00 UTC; allowedCumKWh plateaus at the 20 kWh cap from index 9, so the
    // whole 17:00-22:00 horizon sits on the exhausted plateau.
    const exhausted = {
      allowedCumKWh: Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20)),
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

    // Control: without rescue the exhausted budget collapses the per-bucket caps to zero.
    expect(run(baseSettings)?.dailyBudgetExhaustedBucketCount).toBeGreaterThan(0);
    // Exempt-always lifts the caps, so the diagnostic must not report budget exhaustion —
    // otherwise a capacity/time-limited cannot_meet is misattributed to the daily budget.
    expect(run(exemptSettings)?.dailyBudgetExhaustedBucketCount).toBe(0);
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
    expect(diagnostic?.status).not.toBe('cannot_meet');
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
    expect(diagnostic?.requestedMinimumStepId).toBe('low');
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS).toISOString())).toBeCloseTo(1);
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS + HOUR_MS).toISOString())).toBe(0);
    expect(plannedBySourceBucket(plannedBuckets, new Date(NOW_MS + 2 * HOUR_MS).toISOString())).toBeCloseTo(1);
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
      status: 'on_track',
      reasonCode: 'planned_with_margin',
      currentTemperatureC: 55,
      targetTemperatureC: 65,
      energyNeededKWh: 8,
      kWhPerDegreeC: 0.8,
      requestedMinimumStepId: 'heat',
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
    expect(buffered?.kWhPerDegreeC).toBeCloseTo(0.8);

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
    expect(diagnostic?.kWhPerPercent).toBeCloseTo(0.2);
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
          model: 'stepped_load',
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
    expect(diagnostic?.status).toBe('cannot_meet');
    expect(diagnostic?.horizonPlan?.unplannedUsefulEnergyKWh).toBeGreaterThan(0);
  });

  it('surfaces dailyBudgetExhaustedBucketCount on a budget-bound at_risk plan so the UI can explain the constraint', () => {
    // allowedCumKWh plateaus at the 20 kWh daily cap from index 9 onwards, so
    // every horizon bucket (17–20 with the default 21:00 deadline) inherits a
    // 0 kWh per-bucket cap purely because the daily budget cap was already hit
    // before now. The diagnostic must carry that signal so the UI can tell the
    // user the budget — not the device or schedule — is the constraint.
    const plateauedAllowed = Array.from({ length: 24 }, (_, index) => Math.min((index + 1) * 2, 20));
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({
        prices: Array.from({ length: 24 }, () => 5),
        allowedCumKWh: plateauedAllowed,
        plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      }),
      priceOptimizationEnabled: true,
    });

    // Cumulative budget exhaustion is budget-bound (uncapped it would fit), so
    // the verdict is at_risk/limited_by_daily_budget rather than a physical
    // cannot_meet; the exhausted-bucket count still explains the constraint.
    expect(diagnostic?.status).toBe('at_risk');
    expect(diagnostic?.reasonCode).toBe('limited_by_daily_budget');
    expect(diagnostic?.dailyBudgetExhaustedBucketCount).toBe(4);
  });

  it('reports zero exhausted buckets when the daily budget is not yet exhausted', () => {
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

    expect(diagnostic?.status).toBe('on_track');
    expect(diagnostic?.dailyBudgetExhaustedBucketCount).toBe(0);
  });

  it('does not plan a temperature objective from stale progress', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildTemperatureDevice({ observationStale: true })],
      settings: normalizeDeferredObjectiveSettings(buildTemperatureSettings()),
      powerTracker: buildTemperaturePowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'temperature',
      status: 'unknown',
      reasonCode: 'objective_progress_stale',
      currentTemperatureC: 55,
      energyNeededKWh: null,
    });
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
      status: 'unknown',
      reasonCode: 'objective_missing_price_horizon',
      currentPercent: 40,
      energyNeededKWh: 4,
      kWhPerPercent: 0.2,
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
      status: 'on_track',
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
      status: 'unknown',
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
        stateOfCharge: {
          percent: 40,
          status: 'stale',
          observedAtMs: NOW_MS - HOUR_MS,
        },
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });

    expect(diagnostic).toMatchObject({
      status: 'unknown',
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
        stateOfCharge: {
          percent: 70,
          status: 'fresh',
          observedAtMs: NOW_MS,
        },
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
        stateOfCharge: {
          percent: 40,
          status: 'stale',
          observedAtMs: NOW_MS,
        },
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
      status: 'unknown',
      reasonCode: 'objective_price_feature_disabled',
      currentPercent: null,
    });
    expect(entry.outcome).toBe('met');
    expect(entry.metAtMs).toBe(NOW_MS);
    expect(entry.finalProgressPercent).toBe(70);
  });

  it('marks a met EV objective as satisfied even when price planning is disabled', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: {
          percent: 70,
          status: 'fresh',
          observedAtMs: NOW_MS,
        },
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: false,
    });

    expect(diagnostic).toMatchObject({
      objectiveKind: 'ev_soc',
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      currentPercent: 70,
      targetPercent: 60,
      energyNeededKWh: 0,
      requestedMinimumStepId: null,
    });
  });

  it('marks a met EV objective as satisfied while waiting for tomorrow prices', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: {
          percent: 70,
          status: 'fresh',
          observedAtMs: NOW_MS,
        },
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
      status: 'satisfied',
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
        status: 'satisfied',
        reasonCode: 'energy_already_met',
        currentTemperatureC: 66,
        targetTemperatureC: 65,
        energyNeededKWh: 0,
        requestedMinimumStepId: null,
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
        stateOfCharge: {
          percent: 70,
          status: 'fresh',
          observedAtMs: NOW_MS,
        },
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
        stateOfCharge: {
          percent: 40,
          status: 'fresh',
          observedAtMs: NOW_MS,
        },
      })],
      settings: trackingSettings,
      powerTracker: buildPowerTracker(),
      dailyBudgetSnapshot: buildSnapshot({ prices: Array.from({ length: 24 }, () => 5) }),
      priceOptimizationEnabled: true,
    })[0];

    expect(satisfied).toMatchObject({
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
    });
    expect(tracking).toMatchObject({
      status: 'on_track',
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
      status: 'on_track',
      energyNeededKWh: 2,
      kWhPerPercent: 1,
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
      kWhPerPercent: 0.2,
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
      status: 'unknown',
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
    const heater: PlanInputDevice = {
      id: 'heater-1',
      name: 'Mill v2 Panel Heater',
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      currentOn: true,
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      measuredPowerKw: 1.5,
      // No `steppedLoadProfile`, no `planningPowerKw` — this is what the bug
      // depends on.
    };
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

    // Pre-fix this would have been `status: 'unknown'`,
    // `reasonCode: 'objective_missing_charge_rate'`, `horizonPlan: undefined`.
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.reasonCode).not.toBe('objective_missing_charge_rate');
    expect(diagnostic!.reasonCode).not.toBe('objective_missing_capacity');
    // Energy needed = 3 °C × 0.3004 kWh/°C ≈ 0.9012 kWh (no σ, no buffer
    // contribution).
    expect(diagnostic!.energyNeededKWh).toBeCloseTo(0.9012, 3);
    expect(diagnostic!.kWhPerDegreeC).toBeCloseTo(0.3004, 3);
    // Horizon plan was built — the fallback step plumbed through to the
    // bucket allocator. `requestedMinimumStepId` is the synthetic `charge`
    // step the producer emitted; consumers that previously short-circuited
    // on a `null` minimum step now have an actionable plan to render.
    expect(diagnostic!.horizonPlan).toBeDefined();
    expect(diagnostic!.requestedMinimumStepId).toBe('charge');
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
    const heater: PlanInputDevice = {
      id: 'heater-1',
      name: 'Idle Panel Heater',
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      currentOn: false,
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      // Heater is currently idle — measured draw is zero.
      measuredPowerKw: 0,
      expectedPowerKw: 2.0,
      powerKw: 2.0,
    };
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
    expect(diagnostic!.requestedMinimumStepId).toBe('charge');
  });

  it('still reports missing_charge_rate for a thermostat without any usable power source', () => {
    // The thermal fallback only fires when at least one of
    // `measuredPowerKw` / `expectedPowerKw` / `powerKw` is positive-finite.
    // A device without `measure_power`, without a load setting, and without
    // Homey Energy data still ends up at `objective_missing_charge_rate` —
    // which `activePlanRecorder` will surface as `pendingReason:
    // missing_capacity` for thermal kinds (intentional cold-start hero
    // copy). Guards against the fallback over-reaching.
    const heater: PlanInputDevice = {
      id: 'heater-1',
      name: 'Powerless Thermostat',
      targets: [{ id: 'target_temperature', value: 22, unit: 'C', min: 5, max: 30, step: 0.5 }],
      currentOn: false,
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      currentTemperature: 19,
      lastFreshDataMs: NOW_MS,
      // No power fields populated at all.
    };
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

    expect(diagnostic).toMatchObject({
      status: 'unknown',
      reasonCode: 'objective_missing_charge_rate',
    });
  });

  it('marks a met objective as satisfied without requiring a charger rate', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice({
        stateOfCharge: {
          percent: 70,
          status: 'fresh',
          observedAtMs: NOW_MS,
        },
        steppedLoadProfile: undefined,
      })],
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      requestedMinimumStepId: null,
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
      status: 'on_track',
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
      status: 'at_risk',
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
      status: 'at_risk',
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
      status: 'at_risk',
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
  describe('concurrent priority-1 fully-reserved tasks share reserved headroom', () => {
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
    const buildPromotableDevice = (id: string): PlanInputDevice => ({
      id,
      name: id,
      targets: [],
      currentOn: false,
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_paused',
      priority: 1,
      stateOfCharge: {
        percent: 40,
        status: 'fresh',
        observedAtMs: NOW_MS,
      },
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'min', planningPowerW: 1000 },
          { id: 'mid', planningPowerW: 2000 },
          { id: 'top', planningPowerW: 3000 },
        ],
      },
    });

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
        status: 'on_track',
      });
    });

    it('divides the reserved headroom across two concurrent fully-reserved tasks so neither can over-book the slot', () => {
      // The bug: both tasks see the full 3 kW reserved headroom and both
      // promote to `top` (3 kW), reporting `on_track` for *both* even though
      // the physical reserved slot only fits one. After the fix: each task
      // sees 1.5 kW → neither `mid` (2 kW) nor `top` (3 kW) fits → floor
      // stays at `min` (1 kW) → 4 kWh placed, 2 kWh short → climbed-band
      // probe softens to `at_risk: feasible_above_floor` for both. The user-
      // visible diagnostic now honestly says "at risk" rather than falsely
      // promising on_track to both tasks competing for the same slot.
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
      for (const diagnostic of diagnostics) {
        expect(diagnostic).toMatchObject({
          status: 'at_risk',
          reasonCode: 'feasible_above_floor',
        });
        // Floor stays at `min` (1 kW × 5 horizon hours = 5 kWh placed) so a
        // 6 kWh need leaves ~1 kWh unplanned. The exact value depends on how
        // the reserve hour is accounted; the verdict flip — not the magnitude
        // — is what this regression guards.
        expect(diagnostic.horizonPlan?.unplannedUsefulEnergyKWh ?? 0).toBeGreaterThan(0);
      }
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
      expect(byDevice.get('ev-1')).toMatchObject({ status: 'on_track' });
      expect(byDevice.get('ev-2')).toMatchObject({
        status: 'at_risk',
        reasonCode: 'feasible_above_floor',
      });
    });

    it('splits headroom symmetrically even when one task carries a prior-cycle commitment and the other is fresh', () => {
      // Sibling to the dual-fresh test above. The dual-fresh fixture
      // covers two top-priority fully-reserved tasks both *without* an
      // `activePlans` entry. This asymmetric variant pins the same split
      // when one task (ev-1) carries an existing commitment from a prior
      // cycle while the other (ev-2) is fresh — both should still count as
      // eligible (count = 2) and each should see `reservedHeadroomKw / 2`
      // (1.5 kW). The observable discriminator is the fresh task's verdict:
      // with the correct split, ev-2's floor stays at `min` (1 kW), 5/6 kWh
      // planned, and the climbed-band probe at `top` (3 kW × 4 = 12 kWh)
      // fits → `at_risk: feasible_above_floor`. If a future regression
      // dropped the committed task from the eligible count (count = 1),
      // ev-2 would see the full 3 kW headroom, promote to `top`, and
      // report `on_track` — this assertion catches that asymmetry.
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
      // The fresh task's verdict is the eligibility-split discriminator.
      // count = 2 (committed task correctly included) → 1.5 kW share →
      // floor stays at `min` → 5/6 short → climbed-band fits at top → at_risk.
      // count = 1 (committed task wrongly excluded) → full 3 kW → floor
      // promotes to `top` → 6/6 fits → on_track. The assertion is on the
      // *fresh* verdict because the committed task's headroom is masked by
      // its 1 kWh/h commitment cap — its verdict doesn't distinguish the
      // split. Pin the fresh verdict (and reasonCode) to lock the split in.
      expect(byDevice.get('ev-2')).toMatchObject({
        status: 'at_risk',
        reasonCode: 'feasible_above_floor',
      });
      // Sanity witness on the committed task. The 1 kWh/h commitment cap
      // masks ev-1's status from distinguishing the split on its own, but
      // `requestedMinimumStepId` still pins the current-bucket step the
      // planner asked for. If a compound regression both dropped ev-1's
      // commitment AND gave it the full 3 kW headroom alone (count = 1
      // just for it), the fresh optimizer would pack the cheapest hours at
      // top step (3 kWh/bucket) and `requestedMinimumStepId` would flip to
      // `top`. Catches that combined-failure mode that the fresh-task
      // verdict alone would miss.
      expect(byDevice.get('ev-1')?.requestedMinimumStepId).toBe('min');
    });
  });
});
