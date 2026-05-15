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
    expect(payload.hero.sectionLabel).toBe('Temperature plan');
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

    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish' && chip.tone === 'warn')).toBe(true);
    expect(payload.hero.metaLine).toMatch(/not be enough time or available power/i);
    expect(payload.hero.metaLine).toMatch(/short by about/i);
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

    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish' && chip.tone === 'warn')).toBe(true);
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
});
