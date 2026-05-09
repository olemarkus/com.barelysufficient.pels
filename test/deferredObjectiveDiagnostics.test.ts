import {
  buildDeferredObjectiveDiagnostics,
  buildDeferredObjectivePolicyHorizon,
  createEmptyDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
} from '../lib/plan/deferredObjectives';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../lib/core/powerTracker';
import type { PlanInputDevice } from '../lib/plan/planTypes';

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
    source: 'capability',
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

const buildSettings = (overrides = {}) => ({
  version: 1,
  objectivesByDeviceId: {
    'ev-1': {
      enabled: true,
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 60,
      deadlineLocalTime: '21:00',
      ...overrides,
    },
  },
});

const buildTemperatureSettings = (overrides = {}) => ({
  version: 1,
  objectivesByDeviceId: {
    'heater-1': {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 65,
      deadlineLocalTime: '21:00',
      ...overrides,
    },
  },
});

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
} = {}): DailyBudgetUiPayload => {
  const nowMs = params.nowMs ?? NOW_MS;
  const today = buildDay({
    dateKey: '2026-01-01',
    startMs: Date.UTC(2026, 0, 1, 0),
    currentBucketIndex: new Date(nowMs).getUTCHours(),
    includePriceFactor: params.includePriceFactor,
    prices: params.prices,
  });
  const days: DailyBudgetUiPayload['days'] = { [today.dateKey]: today };
  if (params.includeTomorrow) {
    const tomorrow = buildDay({
      dateKey: '2026-01-02',
      startMs: Date.UTC(2026, 0, 2, 0),
      currentBucketIndex: 0,
      includePriceFactor: params.includePriceFactor,
      prices: params.prices,
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
      allowedCumKWh: Array.from({ length: 24 }, (_, index) => index + 1),
      price: prices,
      ...(params.includePriceFactor === false
        ? {}
        : { priceFactor: prices.map((price) => (price <= 10 ? 1.2 : 0.8)) }),
    },
  };
};

describe('deferred objective settings', () => {
  it('keeps valid enabled EV SoC objectives and drops invalid entries', () => {
    expect(normalizeDeferredObjectiveSettings({
      version: 1,
      objectivesByDeviceId: {
        'ev-1': {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'hard',
          targetPercent: 80,
          deadlineLocalTime: '07:30',
        },
        bad: {
          enabled: true,
          kind: 'ev_soc',
          enforcement: 'hard',
          targetPercent: 120,
          deadlineLocalTime: '07:30',
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
          deadlineLocalTime: '07:30',
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
          deadlineLocalTime: '08:15',
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
          deadlineLocalTime: '08:15',
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
          deadlineLocalTime: '08:00',
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
          deadlineLocalTime: '08:00',
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
    expect(normalizeDeferredObjectiveSettings({ version: 2 })).toEqual(createEmptyDeferredObjectiveSettings());
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
      deadlineRollsToNextDay: true,
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
      deadlineRollsToNextDay: true,
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
      energyNeededKWh: null,
    });
  });

  it('does not infer energy when learned kWh per percent is missing', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics({
      nowMs: NOW_MS,
      timeZone: 'UTC',
      devices: [buildDevice()],
      settings: normalizeDeferredObjectiveSettings(buildSettings()),
      powerTracker: {},
      dailyBudgetSnapshot: buildSnapshot(),
      priceOptimizationEnabled: true,
    });

    expect(diagnostic).toMatchObject({
      status: 'unknown',
      reasonCode: 'objective_missing_capacity',
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
          source: 'capability',
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
