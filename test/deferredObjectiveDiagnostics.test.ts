import {
  buildDeferredObjectiveDiagnostics,
  buildDeferredObjectivePolicyHorizon,
  createEmptyDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
} from '../lib/plan/deferredObjectives';
import { DeferredObjectivePlanHistoryRecorder } from '../lib/plan/deferredObjectives/planHistory';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanInputDevice } from '../lib/plan/planTypes';
import type { DeferredObjectivePlanHistoryV2 } from '../packages/contracts/src/deferredObjectivePlanHistory';

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
  saved: () => DeferredObjectivePlanHistoryV2 | null;
} => {
  let saved: DeferredObjectivePlanHistoryV2 | null = null;
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
});

describe('buildDeferredObjectiveDiagnostics', () => {
  it('plans a persisted EV SoC objective through price-shaped horizon buckets', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
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
      horizonBucketCount: 4,
    });
    expect(diagnostic?.horizonPlan?.plannedBuckets.some((bucket) => bucket.preference === 'preferred')).toBe(true);
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
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
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
      settings: normalizeDeferredObjectiveSettings(buildSettings({ targetPercent: 60 })),
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
});
