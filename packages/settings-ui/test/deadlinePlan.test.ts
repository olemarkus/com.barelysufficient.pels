import { describe, expect, it } from 'vitest';
import { testExports } from '../src/ui/deadlinePlan.ts';
import type { SettingsUiBootstrap, SettingsUiPricesPayload } from '../../contracts/src/settingsUiApi.ts';
import type { DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../contracts/src/deferredObjectiveActivePlans.ts';
import { deadlineLabels } from '../../shared-domain/src/deadlineLabels.ts';

const atLocalHour = (base: Date, hourOffset: number): Date => {
  const date = new Date(base);
  date.setHours(date.getHours() + hourOffset, 0, 0, 0);
  return date;
};

const expectOk = (result: ReturnType<typeof testExports.buildObjectivePayload>) => {
  if (!result || result.kind !== 'ok') {
    throw new Error(`expected buildObjectivePayload ok, got ${result ? result.kind : 'null'}`);
  }
  return result.payload;
};

it('uses domain-specific measured series labels', () => {
  expect(deadlineLabels('temperature').actualDeviceSeriesName).toBe('Measured Heating');
  expect(deadlineLabels('ev_soc').actualDeviceSeriesName).toBe('Measured Charging');
});

const buildActivePlans = (
  plan: DeferredObjectiveActivePlanV1 | null,
): DeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: plan ? { [plan.deviceId]: plan } : {},
});

const buildHeaterActivePlan = (params: {
  now: Date;
  deadline: Date;
  plannedHourOffsets: number[]; // hour offsets from `now` where the device charges
  plannedKWhPerHour: number;
  latestHourOffsets?: number[];
  targetTemperatureC?: number;
  energyNeededKWh?: number;
  planStatus?: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied';
  dailyBudgetExhaustedBucketCount?: number;
}): DeferredObjectiveActivePlanV1 => {
  const revisedAtMs = params.now.getTime();
  const buildHours = (offsets: number[]) => offsets.map((offset) => ({
    startsAtMs: atLocalHour(params.now, offset).getTime(),
    plannedKWh: params.plannedKWhPerHour,
  }));
  const originalHours = buildHours(params.plannedHourOffsets);
  const originalRevision = {
    revision: 1,
    revisedAtMs,
    computedFromPricesUpTo: params.deadline.getTime(),
    reason: 'flow_card' as const,
    hours: originalHours,
    energyNeededKWh: params.energyNeededKWh
      ?? params.plannedHourOffsets.length * params.plannedKWhPerHour,
    planStatus: params.planStatus ?? ('on_track' as const),
    ...(params.dailyBudgetExhaustedBucketCount !== undefined
      ? { dailyBudgetExhaustedBucketCount: params.dailyBudgetExhaustedBucketCount }
      : {}),
  };
  const latestRevision = params.latestHourOffsets
    ? {
      ...originalRevision,
      revision: 2,
      revisedAtMs: revisedAtMs + 60 * 1000,
      reason: 'prices_revised' as const,
      hours: buildHours(params.latestHourOffsets),
    }
    : originalRevision;
  return {
    deviceId: 'heater',
    deviceName: 'Connected 300',
    objectiveKind: 'temperature',
    targetTemperatureC: params.targetTemperatureC ?? 22,
    targetPercent: null,
    deadlineAtMs: params.deadline.getTime(),
    startedAtMs: revisedAtMs,
    pending: false,
    objectiveSignature: 'sig',
    original: originalRevision,
    latest: latestRevision,
  };
};

const buildBootstrap = (
  settings: SettingsUiBootstrap['settings'],
  activePlan: DeferredObjectiveActivePlanV1 | null = null,
): SettingsUiBootstrap => ({
  settings,
  dailyBudget: null,
  deferredObjectiveActivePlans: buildActivePlans(activePlan),
  plan: null,
  power: {
    tracker: {
      objectiveProfiles: {
        heater: {
          kind: 'temperature',
          updatedAtMs: Date.now(),
          lastSample: {
            observedAtMs: Date.now(),
            value: 18,
            unit: 'degree_c',
          },
          kwhPerUnit: {
            sampleCount: 8,
            mean: 1,
            m2: 0,
            min: 1,
            max: 1,
            confidence: 'high',
            lastUpdatedMs: Date.now(),
          },
          acceptedSamples: 8,
          rejectedSamples: 0,
        },
      },
    },
    status: null,
    heartbeat: null,
  },
  prices: {
    combinedPrices: null,
    electricityPrices: null,
    priceArea: null,
    gridTariffData: null,
    flowToday: null,
    flowTomorrow: null,
    homeyCurrency: null,
    homeyToday: null,
    homeyTomorrow: null,
  },
});

const buildDailyBudget = (now: Date, params: {
  controlledKWh: number;
  plannedKWh: number;
  uncontrolledKWh: number;
}): DailyBudgetUiPayload => {
  const startUtc = Array.from({ length: 24 }, (_, hour) => {
    const date = new Date(now);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  });
  return {
    todayKey: '2026-01-01',
    days: {
      '2026-01-01': {
        dateKey: '2026-01-01',
        timeZone: 'UTC',
        nowUtc: now.toISOString(),
        dayStartUtc: startUtc[0] ?? now.toISOString(),
        currentBucketIndex: now.getHours(),
        budget: { enabled: true, dailyBudgetKWh: 20, priceShapingEnabled: true },
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
          startLocalLabels: startUtc.map((value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', hour12: false })),
          plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
          plannedKWh: Array.from({ length: 24 }, () => params.plannedKWh),
          plannedUncontrolledKWh: Array.from({ length: 24 }, () => params.uncontrolledKWh),
          plannedControlledKWh: Array.from({ length: 24 }, () => params.controlledKWh),
          actualKWh: Array.from({ length: 24 }, () => 0),
          actualControlledKWh: Array.from({ length: 24 }, () => null),
          actualUncontrolledKWh: Array.from({ length: 24 }, () => null),
          allowedCumKWh: Array.from({ length: 24 }, (_, index) => index + 1),
        },
      },
    },
  };
};

describe('deadline plan page payload', () => {
  it('builds a device plan from saved objective settings and stops at the deadline', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 10 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: offset === 5 ? 10 : 100 + offset,
          isCheap: offset === 5,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        // Cheap hour is at offset 5 in the prices fixture; runtime planner
        // would have selected it.
        plannedHourOffsets: [5],
        plannedKWhPerHour: 4,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.kind).toBe('temperature');
    // Section label uses smart-task-noun vocabulary, not planner-noun "plan".
    expect(payload.hero.sectionLabel).toBe('Heating smart task');
    expect(payload.hero.subline).toContain('Connected 300');
    expect(payload.hero.subline).toContain('22 °C');
    const chipTexts = payload.hero.chips.map((chip) => chip.text);
    expect(new Set(chipTexts).size).toBe(chipTexts.length);
    expect(chipTexts).not.toContain('Charging');
    expect(payload.timeline.hours).toHaveLength(6);
    const hours = payload.timeline.hours;
    expect(hours[hours.length - 1]?.time).toBe(`${String(deadline.getHours() - 1).padStart(2, '0')}:00`);
    expect(payload.timeline.hours.some((hour) => hour.planned)).toBe(true);
    // Prices are normalized to the same kr/kWh display the Budget chart uses,
    // so a raw 10 øre/kWh value shows as 0.10 kr/kWh here.
    expect(payload.timeline.hours.some((hour) => hour.planned && hour.price === '0.10')).toBe(true);
  });

  it('uses the learned objective sample when live temperature is missing', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0, 1],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.metaLine).toContain('Needs 4.0 kWh');
    expect(payload.timeline.hours.some((hour) => hour.planned)).toBe(true);
  });

  it('accepts legacy combined prices stored as a plain array', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: Array.from({ length: 6 }, (_, offset) => ({
        startsAt: atLocalHour(now, offset).toISOString(),
        totalPrice: 100 + offset,
      })),
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0, 1],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.timeline.hours).toHaveLength(6);
    expect(payload.timeline.hours.some((hour) => hour.planned)).toBe(true);
  });

  it('returns a pending render input when an active plan is marked pending', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const pendingPlan: DeferredObjectiveActivePlanV1 = {
      ...buildHeaterActivePlan({ now, deadline, plannedHourOffsets: [], plannedKWhPerHour: 0 }),
      pending: true,
      original: null,
      latest: null,
    };

    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, pendingPlan),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });

    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.kind).toBe('temperature');
    expect(renderInput.pending.hero.headline).toContain('Waiting');
    expect(renderInput.pending.hero.subline).toContain('Connected 300');
  });

  it('returns a pending render input when no active plan record exists yet', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, null),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });

    expect(renderInput?.status).toBe('pending');
  });

  it('chart background series shows only the uncontrolled forecast, regardless of device priority', () => {
    // The chart's "Background usage" series matches the same `plannedUncontrolledKWh`
    // value the planner subtracts when sizing per-bucket capacity. Controlled forecasts
    // are not added on top — they'd double-count this device's typical contribution.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const buildBootstrapFor = (priority: number | undefined) => {
      const bootstrap = buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0],
        plannedKWhPerHour: 2,
      }));
      bootstrap.dailyBudget = buildDailyBudget(now, {
        controlledKWh: 4,
        plannedKWh: 5,
        uncontrolledKWh: 1,
      });
      const device: TargetDeviceSnapshot = {
        id: 'heater',
        name: 'Connected 300',
        currentOn: false,
        currentTemperature: 18,
        planningPowerKw: 2,
        ...(priority !== undefined ? { priority } : {}),
        targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
      };
      return { bootstrap, devices: [device] };
    };

    for (const priority of [1, 5, undefined]) {
      const { bootstrap, devices } = buildBootstrapFor(priority);
      const payload = expectOk(testExports.buildObjectivePayload({
        bootstrap,
        deviceId: 'heater',
        devices,
        prices,
        nowMs: now.getTime(),
      }));
      expect(payload.timeline.hours[0]?.usage.backgroundKwh).toBe(1);
      expect(payload.timeline.hours[0]?.usage.originalDeviceKwh).toBe(2);
      expect(payload.timeline.hours[0]?.usage.deviceKwh).toBe(2);
    }
  });

  it('carries original and current plan allocations for changed chart hours', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [1],
        latestHourOffsets: [2],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.timeline.hours[1]).toMatchObject({
      changed: true,
      planned: false,
      usage: { originalDeviceKwh: 2, deviceKwh: 0 },
    });
    expect(payload.timeline.hours[2]).toMatchObject({
      changed: true,
      planned: true,
      usage: { originalDeviceKwh: 0, deviceKwh: 2 },
    });
  });

  it('maps measured per-device buckets into deadline timeline actuals', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 4);
    const actualHour = atLocalHour(now, 1).toISOString();
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 4 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [1],
      plannedKWhPerHour: 2,
    }));
    bootstrap.power.tracker = {
      ...bootstrap.power.tracker,
      deviceBuckets: {
        heater: { [actualHour]: 1.25 },
      },
    };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.labels.actualDeviceSeriesName).toBe('Measured Heating');
    expect(payload.timeline.hours[0]?.usage.actualDeviceKwh).toBeNull();
    expect(payload.timeline.hours[1]?.usage.actualDeviceKwh).toBe(1.25);
  });

  it('surfaces planInputs for a temperature device using the learned rate and the lowest step', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0, 1],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.planInputs.perUnitRateLabel).toBe('1.00 kWh/°C');
    expect(payload.planInputs.maxPowerLabel).toBe('2.0 kW');
  });

  it('planInputs maxPowerLabel uses the lowest non-zero stepped-load step', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      // Stepped profile; the lowest non-zero step is 1.5 kW. resolveUsefulPowerKw
      // (used elsewhere) would return the highest step — we deliberately want the lowest.
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1500 },
          { id: 'high', planningPowerW: 3000 },
        ],
      },
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0],
        plannedKWhPerHour: 1.5,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.planInputs.maxPowerLabel).toBe('1.5 kW');
  });

  it('renders the allocated plan even when the device profile is not yet learned', () => {
    // Reproduces the user-reported "Smart task plan unavailable" after prices
    // arrived: the recorder has written an allocation but
    // powerTracker.objectiveProfiles is empty (no learned kwhPerUnit). The UI
    // must compute energy from the stored allocation, not the absent profile.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1, 2],
      plannedKWhPerHour: 1.5,
    }));
    // Strip the learned profile so the UI must lean on the allocation.
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.metaLine).toContain('Needs 4.5 kWh');
  });

  it('renders a cannot-meet plan with a warning chip and shortfall sub-line', () => {
    // The recorder writes a revision under planStatus=cannot_meet (best-effort
    // allocation that still falls short of the target). The UI must render the
    // timeline rather than the legacy "plan unavailable" error and surface
    // both a warning chip and the shortfall to the user.
    const now = new Date(2026, 0, 1, 4, 0, 0, 0);
    const deadline = atLocalHour(now, 2);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 40, // far from target 65 with only 2 h horizon
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 80, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 2 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 65,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1],
      plannedKWhPerHour: 2,
      targetTemperatureC: 65,
      energyNeededKWh: 16,
      planStatus: 'cannot_meet',
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    // The Cannot-finish chip mirrors the hero rim — `cannot_meet` → `alert`
    // on both — so the user never sees a red rim with an amber chip.
    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish' && chip.tone === 'alert')).toBe(true);
    expect(payload.hero.metaLine).toMatch(/not be enough time or available power/i);
    expect(payload.hero.metaLine).toMatch(/short by about/i);
    expect(payload.hero.tone).toBe('alert');
    // No live-state chip ("On track" / "Heating now") should appear alongside
    // "Cannot finish"; the contradiction is the bug we are guarding against.
    expect(payload.hero.chips.some((chip) => chip.text === 'On track')).toBe(false);
    expect(payload.hero.chips.some((chip) => chip.text === 'Heating')).toBe(false);
  });

  it('explains a cannot-meet plan with daily-budget-exhausted hint when the recorder flagged it', () => {
    // When the diagnostic reports that one or more horizon buckets had zero
    // headroom because the daily budget cap was already reached, the meta
    // line must point the user at the budget — not the device — and offer
    // the lower-the-budget remedy.
    const now = new Date(2026, 0, 1, 19, 0, 0, 0);
    const deadline = atLocalHour(now, 3);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 80, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 3 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 50 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [],
      plannedKWhPerHour: 0,
      targetTemperatureC: 22,
      energyNeededKWh: 4,
      planStatus: 'cannot_meet',
      dailyBudgetExhaustedBucketCount: 3,
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish' && chip.tone === 'alert')).toBe(true);
    expect(payload.hero.metaLine).toMatch(/daily energy budget is already used up/i);
    expect(payload.hero.metaLine).toMatch(/lower the daily budget/i);
    // The shortfall copy must not also appear — the budget message is the
    // chosen explanation when the recorder flagged the cause.
    expect(payload.hero.metaLine).not.toMatch(/short by about/i);
  });

  it('routes a passed deadline to the completed state on the History tab', () => {
    const now = new Date(2026, 0, 1, 7, 0, 0, 0);
    const deadline = atLocalHour(now, -1); // already passed
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 21,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, null),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });

    expect(renderInput?.status).toBe('completed');
    if (renderInput?.status !== 'completed') return;
    expect(renderInput.kind).toBe('temperature');
  });

  it('returns no_current_reading when the device has no temperature and no profile sample', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 2,
    }));
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const result = testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(result?.kind).toBe('unavailable');
    if (result?.kind !== 'unavailable') return;
    expect(result.reason).toBe('no_current_reading');
  });

  it('renders without a maxPowerLabel when the device has no planning power', () => {
    // Devices without a configured planning power no longer block the page;
    // the timeline still renders and `planInputs.maxPowerLabel` is simply
    // null so the row is omitted.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 2,
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.planInputs.maxPowerLabel).toBeNull();
  });

  it('falls back to the pending hero when prices do not cover the deadline window', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 2,
    }));

    const renderInput = testExports.resolveRenderInput({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Waiting for tomorrow’s prices');
  });

  it('renders the price-feature-disabled pending hero when the active plan carries that reason', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const pendingPlan: DeferredObjectiveActivePlanV1 = {
      ...buildHeaterActivePlan({ now, deadline, plannedHourOffsets: [], plannedKWhPerHour: 0 }),
      pending: true,
      pendingReason: 'price_feature_disabled',
      original: null,
      latest: null,
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, pendingPlan),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Price-aware optimisation is off');
  });

  it('returns already_satisfied when the device is already at or above the target', () => {
    // Reproduces the reported case: the planner wrote a revision but the device's current
    // temperature already meets the target, so the UI must say "already at target" rather than
    // "no energy estimate".
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 23, // > target 22
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 0,
    }));
    // Strip the learned profile so the only thing keeping the UI from rendering is the
    // already-satisfied state, not a missing kWh-per-unit estimate.
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const result = testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(result?.kind).toBe('unavailable');
    if (result?.kind !== 'unavailable') return;
    expect(result.reason).toBe('already_satisfied');
  });

  it('renders the device_data_missing pending hero when the recorder flagged a progress-side failure', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      // Intentionally no currentTemperature — mirrors the live failure mode.
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const pendingPlan: DeferredObjectiveActivePlanV1 = {
      ...buildHeaterActivePlan({ now, deadline, plannedHourOffsets: [], plannedKWhPerHour: 0 }),
      pending: true,
      pendingReason: 'device_data_missing',
      original: null,
      latest: null,
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, pendingPlan),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Waiting for a reading from the device');
  });

  it('renders the EV device_data_missing pending hero', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const pendingPlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: true,
      pendingReason: 'device_data_missing',
      objectiveSignature: 'sig',
      original: null,
      latest: null,
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            ev: {
              enabled: true,
              kind: 'ev_soc',
              enforcement: 'soft',
              targetPercent: 80,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, pendingPlan),
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Waiting for a reading from the EV');
  });

  it('falls back to the pending hero for EVs when prices do not cover the deadline window', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: {
        revision: 1,
        revisedAtMs: now.getTime(),
        computedFromPricesUpTo: deadline.getTime(),
        reason: 'flow_card',
        hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 5 }],
        energyNeededKWh: 5,
        planStatus: 'on_track',
      },
      latest: {
        revision: 1,
        revisedAtMs: now.getTime(),
        computedFromPricesUpTo: deadline.getTime(),
        reason: 'flow_card',
        hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 5 }],
        energyNeededKWh: 5,
        planStatus: 'on_track',
      },
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            ev: {
              enabled: true,
              kind: 'ev_soc',
              enforcement: 'soft',
              targetPercent: 80,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, activePlan),
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Waiting for tomorrow’s prices');
  });

  it('shows the bootstrap kWh-per-percent value and refining note when the latest revision was sourced from bootstrap', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrapRevision = {
      revision: 1,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'flow_card' as const,
      hours: [
        { startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 7 },
        { startsAtMs: atLocalHour(now, 1).getTime(), plannedKWh: 7 },
        { startsAtMs: atLocalHour(now, 2).getTime(), plannedKWh: 6 },
      ],
      energyNeededKWh: 20,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'bootstrap' as const,
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: bootstrapRevision,
      latest: bootstrapRevision,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          ev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 60,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    // No learned EV profile — only the heater placeholder.
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.planInputs.perUnitRateLabel).toBe('1.00 kWh/%');
    expect(payload.planInputs.perUnitRateNote).toBe('Estimated — refining as PELS observes charging.');
  });

  it('omits the bootstrap note once the revision has been refined to learned data', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const learnedRevision = {
      revision: 2,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'rate_refined' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 3 }],
      energyNeededKWh: 3,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'learned' as const,
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: { ...learnedRevision, revision: 1, reason: 'flow_card' as const, kwhPerUnitSource: 'bootstrap' as const },
      latest: learnedRevision,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          ev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 60,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    // Learned profile now present for the EV.
    bootstrap.power.tracker = {
      objectiveProfiles: {
        ev: {
          kind: 'ev_soc',
          updatedAtMs: now.getTime(),
          lastSample: { observedAtMs: now.getTime(), value: 41, unit: 'percent' },
          kwhPerUnit: {
            sampleCount: 3,
            mean: 0.15,
            m2: 0,
            min: 0.15,
            max: 0.15,
            confidence: 'low',
            lastUpdatedMs: now.getTime(),
          },
          acceptedSamples: 3,
          rejectedSamples: 0,
        },
      },
    };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.planInputs.perUnitRateLabel).toBe('0.15 kWh/%');
    expect(payload.planInputs.perUnitRateNote).toBeNull();
  });

  it('surfaces the kWhPerUnit provenance rows when the active plan carries a learned profile', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const lastAccepted = new Date(2026, 0, 1, 11, 0, 0, 0);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const learnedRevision = {
      revision: 2,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'rate_refined' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 3 }],
      energyNeededKWh: 3,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'learned' as const,
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      kwhPerUnitProvenance: {
        source: 'learned',
        kWhPerUnit: 0.42,
        acceptedSamples: 12,
        confidence: 'medium',
        lastAcceptedAtMs: lastAccepted.getTime(),
      },
      original: learnedRevision,
      latest: learnedRevision,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          ev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 60,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    const labels = payload.planInputs.provenanceRows.map((row) => row.label);
    expect(labels).toEqual(['Source', 'Learned rate', 'Samples', 'Last sample']);
    const byLabel = Object.fromEntries(payload.planInputs.provenanceRows.map((row) => [row.label, row.value]));
    expect(byLabel.Source).toBe('Learned profile');
    expect(byLabel['Learned rate']).toBe('0.42 kWh/%');
    expect(byLabel.Samples).toBe('12 accepted samples · medium confidence');
    // The "Last sample" value is locale/timezone-formatted by the browser; we
    // pin only that it is non-empty so the production formatter stays free to
    // evolve without breaking the test on CI machines with different locales.
    expect(byLabel['Last sample'].length).toBeGreaterThan(0);
  });

  it('surfaces a single "Bootstrap estimate" provenance row when the plan still uses bootstrap', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrapRevision = {
      revision: 1,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'flow_card' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 7 }],
      energyNeededKWh: 7,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'bootstrap' as const,
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      kwhPerUnitProvenance: {
        source: 'bootstrap',
        kWhPerUnit: null,
        acceptedSamples: 0,
        confidence: null,
        lastAcceptedAtMs: null,
      },
      original: bootstrapRevision,
      latest: bootstrapRevision,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          ev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 60,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.planInputs.provenanceRows).toEqual([
      { label: 'Source', value: 'Bootstrap estimate' },
    ]);
  });

  it('returns an empty provenance row list when the plan has no provenance snapshot', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const learnedRevision = {
      revision: 2,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'rate_refined' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 3 }],
      energyNeededKWh: 3,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'learned' as const,
    };
    // Legacy persisted plan: no `kwhPerUnitProvenance` field.
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: learnedRevision,
      latest: learnedRevision,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          ev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 60,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.planInputs.provenanceRows).toEqual([]);
  });

  it('totals every allocated hour into "Needs X kWh", including hours that have already elapsed', () => {
    // Pins the semantics noted in deadlinePlanResolvers.ts: when a plan has past hours, the
    // hero reports the total allocation the planner sized, not just the future portion.
    const planStart = new Date(2026, 0, 1, 10, 0, 0, 0);
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 21,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const allocatedRevision = {
      revision: 1,
      revisedAtMs: planStart.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'flow_card' as const,
      // Two past hours (at planStart and planStart+1h) and one future hour, 1.5 kWh each.
      hours: [
        { startsAtMs: planStart.getTime(), plannedKWh: 1.5 },
        { startsAtMs: planStart.getTime() + 60 * 60 * 1000, plannedKWh: 1.5 },
        { startsAtMs: atLocalHour(now, 1).getTime(), plannedKWh: 1.5 },
      ],
      energyNeededKWh: 4.5,
      planStatus: 'on_track' as const,
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'heater',
      deviceName: 'Connected 300',
      objectiveKind: 'temperature',
      targetTemperatureC: 22,
      targetPercent: null,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: planStart.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: allocatedRevision,
      latest: allocatedRevision,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, activePlan),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    // 3 hours × 1.5 kWh = 4.5 kWh total, not just the 1.5 kWh future hour.
    expect(payload.hero.metaLine).toContain('Needs 4.5 kWh');
  });

  it('surfaces flow-scheme actionable copy when the missing horizon is on the user’s Flow', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [], priceScheme: 'flow', lastFetched: now.toISOString() },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 2,
    }));

    const renderInput = testExports.resolveRenderInput({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Waiting for tomorrow’s prices from your Flow');
    expect(renderInput.pending.hero.metaLine).toContain('Set external prices (tomorrow)');
    expect(renderInput.pending.hero.metaLine).toContain('Last price update:');
  });

  it('keeps managed-scheme copy neutral and surfaces last-update time when present', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [], priceScheme: 'norway', lastFetched: now.toISOString() },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 2,
    }));

    const renderInput = testExports.resolveRenderInput({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Waiting for tomorrow’s prices');
    expect(renderInput.pending.hero.metaLine).not.toContain('Flow');
    expect(renderInput.pending.hero.metaLine).toContain('Last price update:');
  });

  it('omits the last-update hint when combinedPrices has no lastFetched', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [], priceScheme: 'norway' },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC: 22,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0],
      plannedKWhPerHour: 2,
    }));

    const renderInput = testExports.resolveRenderInput({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.metaLine).not.toContain('Last price update:');
  });

  // Live hero chip ordering — canonical `[kind, ?cannotMeet, ?confidence]`.
  // The state chip is no longer rendered on the live hero (TODO 674): the
  // headline already carries the live state (`Heating from HH:MM`,
  // `Charging now`, `On track …`, `Cannot finish`). Pending heroes still emit
  // the state chip in their own builder. High-confidence learned profiles
  // produce no confidence chip (suppressed for the common case).
  it('orders live hero chips as [kind, ?cannotMeet, ?confidence]', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [2],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    const chipTexts = payload.hero.chips.map((chip) => chip.text);
    // High-confidence learned profile suppresses the confidence chip: the
    // healthy plan reads with only the kind chip.
    expect(chipTexts).toEqual(['Temperature']);
  });

  it('headline names the planned start time when no hour is currently active', () => {
    // First charging hour at offset 2; headline should read "Heating from
    // 15:00" instead of the bare "Waiting until 15:00".
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [2],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.headline).toBe(
      `Heating from ${String(atLocalHour(now, 2).getHours()).padStart(2, '0')}:00`,
    );
  });

  it('cannot-meet meta line falls back to a kind-specific named reason when shortfall is zero', () => {
    // Cannot-meet plan with no shortfall and no daily-budget exhaustion must
    // still surface a reasoned body line — never the bare warning chip with
    // no explanation (TODO 344).
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 2);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 21.999,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 2 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0, 1],
        plannedKWhPerHour: 0.0005,
        energyNeededKWh: 0.001,
        planStatus: 'cannot_meet',
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish')).toBe(true);
    expect(payload.hero.metaLine).toMatch(/can't determine why this task is at risk/i);
  });

  it('shows planning speed and estimated duration when the latest revision carries them', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    // Recorder-style revision with planningSpeedKw + estimatedDurationText
    // surfaced. The hero meta line must show all three numeric facts plus
    // the speed-mode badge.
    const revision = {
      revision: 1,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'flow_card' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 4 }],
      energyNeededKWh: 4,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'learned' as const,
      planningSpeedKw: 2,
      estimatedDurationText: '2h',
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'heater',
      deviceName: 'Connected 300',
      objectiveKind: 'temperature',
      targetTemperatureC: 22,
      targetPercent: null,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: revision,
      latest: revision,
    };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, activePlan),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.metaLine).toContain('Needs 4.0 kWh');
    expect(payload.hero.metaLine).toContain('2.0 kW');
    expect(payload.hero.metaLine).toContain('2h');
    expect(payload.hero.metaLine).toContain('Auto');
  });

  it('uses the Learning… speed-mode badge when the latest revision sources from bootstrap', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      stateOfCharge: { percent: 40, status: 'fresh' },
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const bootstrapRevision = {
      revision: 1,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'flow_card' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 7 }],
      energyNeededKWh: 20,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'bootstrap' as const,
      planningSpeedKw: 7,
      estimatedDurationText: '2h 51m',
    };
    const activePlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: false,
      objectiveSignature: 'sig',
      original: bootstrapRevision,
      latest: bootstrapRevision,
    };
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          ev: {
            enabled: true,
            kind: 'ev_soc',
            enforcement: 'soft',
            targetPercent: 60,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    bootstrap.power.tracker = { objectiveProfiles: {} };

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.metaLine).toContain('Learning…');
  });

  it('renders the Paused — unplugged pending hero when the active plan reports invalid_session', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      currentOn: false,
      planningPowerKw: 7,
      targets: [{ id: 'target_state_of_charge', unit: '%', min: 0, max: 100, step: 1 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const pendingPlan: DeferredObjectiveActivePlanV1 = {
      deviceId: 'ev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      deadlineAtMs: deadline.getTime(),
      startedAtMs: now.getTime(),
      pending: true,
      pendingReason: 'invalid_session',
      objectiveSignature: 'sig',
      original: null,
      latest: null,
    };
    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            ev: {
              enabled: true,
              kind: 'ev_soc',
              enforcement: 'soft',
              targetPercent: 80,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, pendingPlan),
      deviceId: 'ev',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Charging plan paused — EV unplugged');
    const chipTexts = renderInput.pending.hero.chips.map((chip) => chip.text);
    expect(chipTexts).toEqual(['EV', 'Paused — unplugged']);
  });

  it('renders the Learning energy use pending hero when the active plan reports missing_capacity', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Bathroom heater',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: { prices: [] },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const pendingPlan: DeferredObjectiveActivePlanV1 = {
      ...buildHeaterActivePlan({ now, deadline, plannedHourOffsets: [], plannedKWhPerHour: 0 }),
      pending: true,
      pendingReason: 'missing_capacity',
      original: null,
      latest: null,
    };

    const renderInput = testExports.resolveRenderInput({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, pendingPlan),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });
    expect(renderInput?.status).toBe('pending');
    if (renderInput?.status !== 'pending') return;
    expect(renderInput.pending.hero.headline).toBe('Learning energy use');
    expect(renderInput.pending.hero.metaLine).toMatch(/needs power readings/i);
    const chipTexts = renderInput.pending.hero.chips.map((chip) => chip.text);
    expect(chipTexts).toEqual(['Temperature', 'Building plan…']);
  });

  it('omits revisionReason on hours that have not changed', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 4);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 4 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [1],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    for (const hour of payload.timeline.hours) {
      expect(hour.revisionReason).toBeNull();
      expect(hour.changed).toBe(false);
    }
  });

  it('sets revisionReason on changed hours and null on unchanged hours', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 30, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 6 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 100 + offset,
        })),
      },
      electricityPrices: null,
      priceArea: null,
      gridTariffData: null,
      flowToday: null,
      flowTomorrow: null,
      homeyCurrency: null,
      homeyToday: null,
      homeyTomorrow: null,
    };
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildBootstrap({
        capacity_limit_kw: 8,
        deferred_objectives: {
          version: 1,
          objectivesByDeviceId: {
            heater: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 22,
              deadlineAtMs: deadline.getTime(),
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [1],
        latestHourOffsets: [2],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    const changedHours = payload.timeline.hours.filter((h) => h.changed);
    const unchangedHours = payload.timeline.hours.filter((h) => !h.changed);
    expect(changedHours.length).toBeGreaterThan(0);
    for (const hour of changedHours) {
      expect(hour.revisionReason).toBe('prices_revised');
    }
    for (const hour of unchangedHours) {
      expect(hour.revisionReason).toBeNull();
    }
  });
});

describe('hero tone resolution', () => {
  it('maps cannot_meet to alert so the rim agrees with the Cannot-finish chip', async () => {
    const { resolveHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroTone('cannot_meet')).toBe('alert');
  });

  it('maps at_risk to warn so an amber rim flags a recoverable shortfall', async () => {
    const { resolveHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroTone('at_risk')).toBe('warn');
  });

  it('maps on_track and satisfied to good so a healthy plan reads green', async () => {
    const { resolveHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroTone('on_track')).toBe('good');
    expect(resolveHeroTone('satisfied')).toBe('good');
  });

  it('maps invalid to info — the planner could not produce a valid plan, neutral rim', async () => {
    const { resolveHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroTone('invalid')).toBe('info');
  });
});

describe('buildHeroChips', () => {
  const labels = deadlineLabels('temperature');

  it('omits any live-state chip — the active hero no longer renders state on the chip row', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const chips = buildHeroChips({
      labels,
      cannotMeet: false,
      cannotMeetChipTone: 'alert',
      confidenceChipText: null,
    });
    // No chip text should equal any of the live-state labels (TODO 674): the
    // headline already says "Heating from HH:MM" / "On track …" / etc.
    const liveStateTexts = Object.values(labels.liveStateChipLabel);
    for (const text of liveStateTexts) {
      expect(chips.some((chip) => chip.text === text)).toBe(false);
    }
    expect(chips.map((chip) => chip.text)).toEqual([labels.kindChipLabel]);
  });

  it('adds the Cannot-finish chip when cannotMeet is true and keeps it in canonical order', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const chips = buildHeroChips({
      labels,
      cannotMeet: true,
      cannotMeetChipTone: 'alert',
      confidenceChipText: null,
    });
    expect(chips.some((chip) => chip.text === labels.cannotMeetChipLabel && chip.tone === 'alert')).toBe(true);
    expect(chips.map((chip) => chip.text)).toEqual([
      labels.kindChipLabel,
      labels.cannotMeetChipLabel,
    ]);
  });

  it('keeps the canonical chip order kind → cannotMeet → confidence when all are present', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const chips = buildHeroChips({
      labels,
      cannotMeet: true,
      cannotMeetChipTone: 'alert',
      confidenceChipText: 'Estimating',
    });
    expect(chips.map((chip) => chip.text)).toEqual([
      labels.kindChipLabel,
      labels.cannotMeetChipLabel,
      'Estimating',
    ]);
  });

  it('honours the supplied cannotMeetChipTone — `warn` for at-risk, `alert` for cannot-meet', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const alertChips = buildHeroChips({
      labels,
      cannotMeet: true,
      cannotMeetChipTone: 'alert',
      confidenceChipText: null,
    });
    expect(alertChips.find((chip) => chip.text === labels.cannotMeetChipLabel)?.tone).toBe('alert');
    const warnChips = buildHeroChips({
      labels,
      cannotMeet: true,
      cannotMeetChipTone: 'warn',
      confidenceChipText: null,
    });
    expect(warnChips.find((chip) => chip.text === labels.cannotMeetChipLabel)?.tone).toBe('warn');
  });
});

describe('resolveConfidenceChipText', () => {
  it('suppresses the chip for high confidence — the common case carries no signal', async () => {
    const { resolveConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveConfidenceChipText('high')).toBeNull();
  });

  it('maps low confidence to the action-oriented `Estimating`', async () => {
    const { resolveConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveConfidenceChipText('low')).toBe('Estimating');
  });

  it('maps medium confidence to the action-oriented `Refining`', async () => {
    const { resolveConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveConfidenceChipText('medium')).toBe('Refining');
  });

  it('returns null when no confidence is available so the chip is suppressed', async () => {
    const { resolveConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveConfidenceChipText(null)).toBeNull();
  });
});

describe('buildChartOption original-series suppression', () => {
  const stubPalette = {
    priceCheap: '#0f0', priceNormal: '#888', priceExpensive: '#f00',
    background: '#333', device: '#0ff', actualDevice: '#0f0', progress: '#00f',
    grid: '#444', text: '#fff', muted: '#aaa',
    tooltipBackground: '#000', tooltipText: '#fff', tooltipBorder: '#555',
  };
  const stubTypography = { labelFontSize: 11, axisNameFontSize: 11, axisNameFontWeight: 700 };

  const buildMinimalPayload = (
    hours: Array<{ originalDeviceKwh: number; deviceKwh: number }>,
  ): import('../src/ui/views/DeadlinePlan.tsx').DeadlinePlanPayload => {
    const labels = deadlineLabels('ev_soc');
    return {
      kind: 'ev_soc',
      labels,
      priceUnitLabel: 'øre/kWh',
      hero: { chips: [], tone: 'good', sectionLabel: 'EV smart task', headline: 'On track', subline: '', metaLine: '' },
      timeline: {
        ariaLabel: 'EV smart task',
        progressFloor: 0,
        progressCeilingValue: 80,
        progressCeilingLabel: '80%',
        deadlineLabel: 'Mon 06',
        hours: hours.map((h, i) => {
          const hourChanged = Math.abs(h.originalDeviceKwh - h.deviceKwh) > 0.001;
          return {
            time: `${13 + i}:00`,
            price: '100.00',
            priceValue: 100,
            tone: 'normal' as const,
            planned: h.deviceKwh > 0,
            changed: hourChanged,
            revisionReason: hourChanged ? 'prices_revised' as const : null,
            usage: {
              backgroundKwh: 0,
              originalDeviceKwh: h.originalDeviceKwh,
              deviceKwh: h.deviceKwh,
              actualDeviceKwh: null,
            },
            progress: 40,
          };
        }),
      },
      planInputs: { perUnitRateLabel: null, perUnitRateNote: null, maxPowerLabel: null, provenanceRows: [] },
    };
  };

  it('suppresses original series in legend and series when no hour has been revised', async () => {
    const { buildChartOption } = await import('../src/ui/views/DeadlinePlan.tsx');
    const payload = buildMinimalPayload([
      { originalDeviceKwh: 5, deviceKwh: 5 },
      { originalDeviceKwh: 5, deviceKwh: 5 },
    ]);
    const option = buildChartOption(payload, stubPalette, stubTypography) as {
      legend: { data: Array<{ name: string }> };
      series: Array<{ name: string }>;
    };
    const legendNames = option.legend.data.map((d) => d.name);
    expect(legendNames).not.toContain(payload.labels.originalDeviceSeriesName);
    const seriesNames = option.series.map((s) => s.name);
    expect(seriesNames).not.toContain(payload.labels.originalDeviceSeriesName);
  });

  it('shows original series in legend and series when at least one hour differs', async () => {
    const { buildChartOption } = await import('../src/ui/views/DeadlinePlan.tsx');
    const payload = buildMinimalPayload([
      { originalDeviceKwh: 5, deviceKwh: 0 },
      { originalDeviceKwh: 0, deviceKwh: 5 },
    ]);
    const option = buildChartOption(payload, stubPalette, stubTypography) as {
      legend: { data: Array<{ name: string }> };
      series: Array<{ name: string }>;
    };
    const legendNames = option.legend.data.map((d) => d.name);
    expect(legendNames).toContain(payload.labels.originalDeviceSeriesName);
    const seriesNames = option.series.map((s) => s.name);
    expect(seriesNames).toContain(payload.labels.originalDeviceSeriesName);
  });
});
