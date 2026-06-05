import { describe, expect, it } from 'vitest';
import { testExports } from '../src/ui/deadlinePlan.ts';
import { pendingChipTone } from '../src/ui/deadlinePlanPending.ts';
import type { SettingsUiBootstrap, SettingsUiPricesPayload } from '../../contracts/src/settingsUiApi.ts';
import type { DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes.ts';
import type { DecoratedDeviceSnapshot } from '../../contracts/src/types.ts';
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../contracts/src/deferredObjectiveActivePlans.ts';
import {
  deadlineLabels,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
} from '../../shared-domain/src/deadlineLabels.ts';

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
  energyExpectedKWh?: number;
  planStatus?: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied';
  dailyBudgetExhaustedBucketCount?: number;
  // Producer-resolved verdict for the floor shortfall. Existing fixtures omit
  // this so the consumer's legacy fallback continues to fire (those tests
  // were written against the count-based heuristic). New fixtures should set
  // this to mirror the producer's mapping for the scenario under test.
  floorShortfallCause?: 'budget' | 'step_power' | 'estimate' | 'time_capacity' | 'none';
  planningSpeedKw?: number;
  initialPlanningSpeedKw?: number;
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
    ...(params.energyExpectedKWh !== undefined ? { energyExpectedKWh: params.energyExpectedKWh } : {}),
    planStatus: params.planStatus ?? ('on_track' as const),
    ...(params.dailyBudgetExhaustedBucketCount !== undefined
      ? { dailyBudgetExhaustedBucketCount: params.dailyBudgetExhaustedBucketCount }
      : {}),
    ...(params.floorShortfallCause !== undefined
      ? { floorShortfallCause: params.floorShortfallCause }
      : {}),
    ...(params.planningSpeedKw !== undefined ? { planningSpeedKw: params.planningSpeedKw } : {}),
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
    ...(params.initialPlanningSpeedKw !== undefined ? { initialPlanningSpeedKw: params.initialPlanningSpeedKw } : {}),
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    // Trust caption: one cheap hour was picked out of the 6-hour window. Window
    // average = (100+101+102+103+104+10)/6 øre = 86.67 øre → 0.87 kr/kWh; the
    // picked hour is the lone 0.10 kr/kWh cheap one. Confirms the producer reads
    // the already-scaled display price (øre→kr) and the window-wide baseline.
    expect(payload.timeline.cheapestHoursCaption).toBe(
      'Picked 1 of 6 hours · avg 0.10 vs window avg 0.87 kr/kWh',
    );
  });

  it('uses the learned objective sample when live temperature is missing', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
      const device: DecoratedDeviceSnapshot = {
        id: 'heater',
        name: 'Connected 300',
        binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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

  it('planInputs maxPowerLabel uses the plan-level learned speed with sub-2 kW precision', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
      currentTemperature: 18,
      planningPowerKw: 1.3,
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
        plannedKWhPerHour: 1.19,
        initialPlanningSpeedKw: 1.19,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.planInputs.maxPowerLabel).toBe('1.19 kW');
  });

  it('surfaces smart-task extra permissions in the learned inputs card', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
              rescue: {
                exemptFromBudget: 'always',
                limitLowerPriorityDevices: 'at_risk',
              },
            },
          },
        },
      }, buildHeaterActivePlan({
        now,
        deadline,
        plannedHourOffsets: [0],
        plannedKWhPerHour: 2,
      })),
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.planInputs.extraPermissionsValue).toBe(
      'May go over daily budget · May limit lower-priority devices if at risk',
    );
    expect(payload.planInputs.maxPowerNote).toBe('Lower-priority devices may be limited separately.');
  });

  it('renders the allocated plan even when the device profile is not yet learned', () => {
    // Reproduces the user-reported "Smart task unavailable" after prices
    // arrived: the recorder has written an allocation but
    // powerTracker.objectiveProfiles is empty (no learned kwhPerUnit). The UI
    // must compute energy from the stored allocation, not the absent profile.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const activePlan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1],
      plannedKWhPerHour: 2,
      targetTemperatureC: 65,
      energyNeededKWh: 16,
      planStatus: 'cannot_meet',
    });
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
    }, activePlan);
    const profile = bootstrap.power.tracker?.objectiveProfiles?.heater;
    if (!profile?.kwhPerUnit) throw new Error('expected heater profile');
    profile.kwhPerUnit.confidence = 'low';

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
    expect(payload.hero.chips.map((chip) => chip.text)).toEqual(['Temperature', 'Cannot finish']);
    expect(payload.hero.chips.some((chip) => chip.text === 'Estimating')).toBe(false);
    // The redundant headline remains suppressed; the chip and reason line
    // carry the cannot-finish signal without adding a second headline.
    expect(payload.hero.headline).toBeNull();
    // Shortfall copy names the cause in plain language ("may not reach the
    // target temperature") rather than rendering a raw °C delta; the meta
    // line still carries the Needs/duration magnitude after the sentence.
    expect(payload.hero.metaLine).toMatch(/not enough time for this target/i);
    expect(payload.hero.metaLine).toMatch(/needs .* kwh/i);
    // The misleading "Short by about 41.9 °C" magnitude must not surface in
    // user copy (TODO 434 in TODO.md).
    expect(payload.hero.metaLine).not.toMatch(/short by about/i);
    expect(payload.hero.tone).toBe('alert');
    // Recourse-action surfaces on cannot-meet; shortfall route picks the
    // Overview tab because the daily-budget cause hasn't fired. The producer
    // also threads the active task's deviceId so the click dispatcher
    // (`deadlinePlanMount.ts`) can deep-link the device-settings overlay
    // after landing on Overview — one click instead of "land on Overview,
    // hunt for the device card." Mirrors the history-detail "Review device"
    // recourse pattern.
    expect(payload.hero.recourse).not.toBeNull();
    expect(payload.hero.recourse?.targetTab).toBe('overview');
    expect(payload.hero.recourse?.deviceId).toBe('heater');
    // No live-state chip ("On track" / "Heating now") should appear alongside
    // "Cannot finish"; the contradiction is the bug we are guarding against.
    expect(payload.hero.chips.some((chip) => chip.text === 'On track')).toBe(false);
    expect(payload.hero.chips.some((chip) => chip.text === 'Heating')).toBe(false);
  });

  it('keeps a pre-v2.9 cannot-meet revision on device-side recourse even when buckets were exhausted in the run-up', () => {
    // Pre-v2.9.x persisted revisions don't carry `floorShortfallCause`, so the
    // consumer falls back to the legacy `bucketCount > 0` heuristic. The fix
    // restricts that heuristic to `at_risk` because by construction the
    // producer (`resolveStatus` in `horizonPlanner.ts`) only returns
    // `cannot_meet` on the `!budgetBound` branch — a `cannot_meet` plan's
    // cause is `time_capacity` (or `step_power` / `estimate`), never
    // `budget`. A pre-v2.9 `cannot_meet` revision whose run-up happened to
    // brush the daily-budget cap (cumulative `dailyBudgetExhaustedBucketCount
    // > 0`) is still a physical/time miss — routing it to "Open Budget"
    // would misdirect the user. Once the recorder re-records each plan
    // post-upgrade the explicit `floorShortfallCause: 'time_capacity'` takes
    // over and the gate becomes moot.
    const now = new Date(2026, 0, 1, 19, 0, 0, 0);
    const deadline = atLocalHour(now, 3);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
      // No `floorShortfallCause` — pre-v2.9.x persisted revision shape.
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish' && chip.tone === 'alert')).toBe(true);
    // No daily-budget message — the cause cannot be budget for a cannot_meet
    // verdict, so the legacy heuristic must not fire.
    expect(payload.hero.metaLine).not.toMatch(/today's daily budget is fully booked/i);
    expect(payload.hero.metaLine).not.toMatch(/lower it so future days reserve power earlier/i);
    // The shortfall copy is the chosen explanation — pointing at the device.
    expect(payload.hero.metaLine).toMatch(/not enough time for this target/i);
    // Recourse stays on the device-side `Adjust device` (Overview tab), not
    // the budget tab. Mirrors the post-v2.9 `time_capacity` route.
    expect(payload.hero.recourse?.targetTab).toBe('overview');
    expect(payload.hero.recourse?.label).toBe('Adjust device');
    expect(payload.hero.recourse?.deviceId).toBe('heater');
    // The reasoned sentence is followed by the rich `Needs N kWh · …` meta
    // (TODO 1276) so users see both "why it's failing" and "how bad".
    expect(payload.hero.metaLine).toMatch(/needs .* kwh/i);
  });

  it('routes a budget-bound at_risk plan to the daily-budget hint and Open Budget recourse', () => {
    // The planner now softens a floor shortfall that is short only because of
    // the daily budget to `at_risk` (not a physical `cannot_meet`). With the
    // recorder still flagging the cumulatively exhausted buckets, the budget
    // cause + the lower-the-budget recourse must follow the reclassification —
    // not regress to device-blaming shortfall copy.
    const now = new Date(2026, 0, 1, 19, 0, 0, 0);
    const deadline = atLocalHour(now, 3);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
      planStatus: 'at_risk',
      dailyBudgetExhaustedBucketCount: 3,
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    // Reclassified to at_risk — not the alarm "Cannot finish" chip…
    expect(payload.hero.chips.some((chip) => chip.text === 'At risk' && chip.tone === 'warn')).toBe(true);
    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish')).toBe(false);
    // …but the budget cause and the Open Budget recourse still follow the plan.
    expect(payload.hero.metaLine).toMatch(/today's daily budget is fully booked/i);
    expect(payload.hero.metaLine).toMatch(/lower it so future days reserve power earlier/i);
    expect(payload.hero.metaLine).not.toMatch(/not enough time for this target/i);
    expect(payload.hero.recourse?.targetTab).toBe('budget');
    expect(payload.hero.recourse?.label).toBe('Open Budget');
    // Budget branch has no device-settings overlay to open — `deviceId` stays
    // absent so the click dispatcher's `length > 0` guard keeps the click on
    // the Budget tab without firing `open-device-detail`.
    expect(payload.hero.recourse?.deviceId).toBeUndefined();
  });

  it('routes the per-bucket squeeze case (bucketCount: 0 + floorShortfallCause: budget) to Open Budget', () => {
    // Prod squeeze repro: the planner sees a per-bucket background-squeeze and
    // resolves `at_risk: limited_by_daily_budget`, but the cumulative
    // `dailyBudgetExhaustedBucketCount` stays at 0 — only the producer's
    // `floorShortfallCause: 'budget'` flag captures that the recourse belongs
    // on the Budget tab. Pre-fix this regressed to the device-side `Adjust
    // device` button.
    const now = new Date(2026, 0, 1, 19, 0, 0, 0);
    const deadline = atLocalHour(now, 3);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
      planStatus: 'at_risk',
      // The squeeze signature: zero exhausted buckets, cause is still budget.
      dailyBudgetExhaustedBucketCount: 0,
      floorShortfallCause: 'budget',
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.metaLine).toMatch(/today's daily budget is fully booked/i);
    expect(payload.hero.metaLine).toMatch(/lower it so future days reserve power earlier/i);
    expect(payload.hero.metaLine).not.toMatch(/not enough time for this target/i);
    expect(payload.hero.recourse?.targetTab).toBe('budget');
    expect(payload.hero.recourse?.label).toBe('Open Budget');
    expect(payload.hero.recourse?.deviceId).toBeUndefined();
  });

  it('keeps device-side routing when floorShortfallCause is step_power and no bucket has been exhausted', () => {
    // Step-power undercount means the floor was short because climbing a
    // higher step (within budget) would help — the cause is device-side, not
    // budget. With `dailyBudgetExhaustedBucketCount: 0` the legacy backstop
    // also stays silent, so neither the new flat field nor the legacy
    // heuristic surface the budget recourse. The hero copy stays on the
    // device-side `Adjust device` button as expected for step-bound floors.
    const now = new Date(2026, 0, 1, 19, 0, 0, 0);
    const deadline = atLocalHour(now, 3);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
      plannedHourOffsets: [1],
      plannedKWhPerHour: 1,
      targetTemperatureC: 22,
      energyNeededKWh: 4,
      planStatus: 'at_risk',
      dailyBudgetExhaustedBucketCount: 0,
      floorShortfallCause: 'step_power',
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    expect(payload.hero.recourse?.targetTab).toBe('overview');
    expect(payload.hero.recourse?.label).toBe('Adjust device');
    expect(payload.hero.metaLine).not.toMatch(/today's daily budget is fully booked/i);
  });

  // Headline-qualifier decision (2026-05-23):
  // The partial-schedule budget-bound hero pairs the live `Heating from HH:MM`
  // / `Heating now` headline (from `resolveHeroHeadline` — `at_risk` keeps
  // its live-state headline when a scheduled hour exists, per the
  // `at_risk: queued first hour preserves the "Heating from HH:MM" live-state
  // headline` regression above and the comment block in
  // `deadlinePlanHero.ts:resolveHeroHeadline`) with the budget-used-up body
  // sentence from `cannotMeetDailyBudgetExhausted`. No qualifier is added to
  // the headline itself: the body sentence already carries the budget cause
  // and the `At risk` chip already warns; folding `(budget capped)` into
  // `Heating from 14:00` would over-load the live-state headline whose job
  // is "what is the device doing right now?". The body sentence (written for
  // the terminal `cannot_meet` tier) is reused on the recoverable `at_risk`
  // tier — its tone reads as the still-honest "PELS can't reserve more
  // before the deadline" and the chip already carries the recoverability
  // signal (`At risk`, not `Cannot finish`). Documented here rather than in
  // the source because the decision is about test scope, not the resolvers.
  it('partial-schedule budget-bound at_risk: keeps the live `Heating from HH:MM` headline and routes the body to the budget cause', () => {
    const now = new Date(2026, 0, 1, 12, 0, 0, 0);
    // Deadline at 16:00 local; first planned hour at 14:00 (offset 2) — the
    // live headline reads `Heating from 14:00` per `resolveHeroHeadline`.
    const deadline = atLocalHour(now, 4);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 80, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 4 }, (_, offset) => ({
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
            targetTemperatureC: 65,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, buildHeaterActivePlan({
      now,
      deadline,
      // Two scheduled hours starting at offset 2 — the live `Heating from
      // HH:MM` headline is the "partial schedule" half of this regression.
      plannedHourOffsets: [2, 3],
      plannedKWhPerHour: 2,
      targetTemperatureC: 65,
      energyNeededKWh: 10,
      planStatus: 'at_risk',
      dailyBudgetExhaustedBucketCount: 3,
    }));

    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    }));

    // Chip side: at-risk keeps the warning chip, not the alarm one.
    expect(payload.hero.chips.some((chip) => chip.text === 'At risk' && chip.tone === 'warn')).toBe(true);
    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish')).toBe(false);
    // Headline side: live state, no budget qualifier (see decision comment
    // block above). 14:00 = now (12:00) + 2h offset.
    expect(payload.hero.headline).toBe('Heating from 14:00');
    // Body side: the budget-used-up sentence carries the cause; the
    // device-blaming `may not reach the target` shortfall copy must not fire.
    expect(payload.hero.metaLine).toMatch(/today's daily budget is fully booked/i);
    expect(payload.hero.metaLine).toMatch(/lower it so future days reserve power earlier/i);
    expect(payload.hero.metaLine).not.toMatch(/not enough time for this target/i);
    // Recourse side: Open Budget, not Adjust device — partial schedule does
    // not change the recourse routing on the budget cause.
    expect(payload.hero.recourse?.targetTab).toBe('budget');
    expect(payload.hero.recourse?.label).toBe('Open Budget');
    expect(payload.hero.recourse?.deviceId).toBeUndefined();
  });

  it('routes a passed deadline to the completed state on the History tab', () => {
    const now = new Date(2026, 0, 1, 7, 0, 0, 0);
    const deadline = atLocalHour(now, -1); // already passed
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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

  it('honours the producer-persisted flat rateMean + speedMode over the live profile', () => {
    // Forward-compat: a revision recorded by the new producer carries flat
    // `rateMean` / `speedMode`. The UI must read those directly and NOT
    // re-derive from the live profile — here the profile mean (0.40) differs
    // from the persisted rate (0.22) to prove the flat field wins.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const revision = {
      revision: 2,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'rate_refined' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 3 }],
      energyNeededKWh: 3,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'learned' as const,
      rateMean: 0.22,
      speedMode: 'auto' as const,
      planningSpeedKw: 7,
      estimatedDurationText: '3h',
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
      original: revision,
      latest: revision,
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
    // Live profile mean deliberately differs from the persisted rateMean.
    bootstrap.power.tracker = {
      objectiveProfiles: {
        ev: {
          kind: 'ev_soc',
          updatedAtMs: now.getTime(),
          lastSample: { observedAtMs: now.getTime(), value: 41, unit: 'percent' },
          kwhPerUnit: {
            sampleCount: 5,
            mean: 0.40,
            m2: 0,
            min: 0.40,
            max: 0.40,
            confidence: 'high',
            lastUpdatedMs: now.getTime(),
          },
          acceptedSamples: 5,
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

    expect(payload.planInputs.perUnitRateLabel).toBe('0.22 kWh/%');
    expect(payload.planInputs.perUnitRateNote).toBeNull();
    expect(payload.hero.metaLine).toContain('Auto');
  });

  it('uses the persisted learning speedMode + bootstrap rateMean with no live profile', () => {
    // Forward-compat bootstrap case: producer persisted `speedMode: 'learning'`
    // and the bootstrap rate; the live profile is absent. The hero badge and
    // the bootstrap note must both come from the flat fields.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const revision = {
      revision: 1,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'flow_card' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 7 }],
      energyNeededKWh: 20,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'bootstrap' as const,
      rateMean: 0.15,
      speedMode: 'learning' as const,
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
      original: revision,
      latest: revision,
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

    expect(payload.planInputs.perUnitRateLabel).toBe('0.15 kWh/%');
    expect(payload.planInputs.perUnitRateNote).toBe('Estimated — refining as PELS observes charging.');
    expect(payload.hero.metaLine).toContain('Learning…');
  });

  it('surfaces the kWhPerUnit provenance rows when the active plan carries a learned profile', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const lastAccepted = new Date(2026, 0, 1, 11, 0, 0, 0);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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

    // `Learned rate` row is intentionally absent — the card's headline row now
    // carries the rate value, so the provenance section drops the duplicate.
    const labels = payload.planInputs.provenanceRows.map((row) => row.label);
    expect(labels).toEqual(['Source', 'Readings used', 'Latest reading used']);
    const byLabel = Object.fromEntries(payload.planInputs.provenanceRows.map((row) => [row.label, row.value]));
    expect(byLabel.Source).toBe('Learned from power readings');
    expect(byLabel['Readings used']).toBe('12 accepted power readings · medium confidence');
    // `lastAccepted` sits 2h before `now`, well inside the 24h freshness
    // window — expect a relative "Updated …" string, not a stale timestamp.
    expect(byLabel['Latest reading used']).toBe('Updated 2 hours ago');
  });

  it('surfaces a single "Starting estimate" provenance row when the plan still uses bootstrap', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
      { label: 'Source', value: 'Starting estimate', tone: null },
    ]);
  });

  it('returns an empty provenance row list when the plan has no provenance snapshot', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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

  // Live hero chip ordering — canonical `[kind, ?status, ?confidence]`.
  // The state chip is no longer rendered on the live hero (TODO 674): the
  // headline already carries the live state (`Heating from HH:MM`,
  // `Charging now`, `On track …`, `Cannot finish`). Pending heroes still emit
  // the state chip in their own builder. High-confidence learned profiles
  // produce no confidence chip (suppressed for the common case).
  it('orders live hero chips as [kind, ?cannotMeet, ?confidence]', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    // Cannot-meet plan with no UI-derived shortfall and no daily-budget
    // exhaustion must still surface the blameless "may not reach the target"
    // sentence — never the old "can't determine why" dead-end. The planner has
    // already classified the plan as cannot-meet, so the UI must not contradict
    // that with an "unknown cause" admission just because its own (learned-rate)
    // projection landed at-or-above target (TODO 344; smart-task hero walk).
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 2);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    expect(payload.hero.metaLine).toMatch(/not enough time for this target/i);
    expect(payload.hero.metaLine).not.toMatch(/can't determine why/i);
  });

  it('shows planning speed and estimated duration when the latest revision carries them', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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

  it('prefers the plan-level snapshot over the shrinking latest-revision duration', () => {
    // Regression for TODO 597: the recorder formats `estimatedDurationText`
    // from `energyNeededKWh / planningSpeedKw` every revision, and
    // `energyNeededKWh` shrinks every cycle as the device consumes energy.
    // The hero meta line must read from the plan-level snapshot frozen at
    // first-revision time so the user sees the original plan-level duration,
    // not the shrinking "remaining" amount.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    // Latest revision says 1h (shrunk after the device consumed half the
    // original 4 kWh plan); the plan-level snapshot says 2h (the original
    // commitment). The hero must show the snapshot.
    const latestRevision = {
      revision: 2,
      revisedAtMs: now.getTime(),
      computedFromPricesUpTo: deadline.getTime(),
      reason: 'prices_revised' as const,
      hours: [{ startsAtMs: atLocalHour(now, 0).getTime(), plannedKWh: 2 }],
      energyNeededKWh: 2,
      planStatus: 'on_track' as const,
      kwhPerUnitSource: 'learned' as const,
      planningSpeedKw: 2,
      estimatedDurationText: '1h',
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
      initialPlanningSpeedKw: 2,
      initialEstimatedDurationText: '2h',
      original: latestRevision,
      latest: latestRevision,
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

    // Frozen plan-level "2h" wins over the latest-revision "1h". Match on
    // the leading `·` separator so the assertion doesn't trip on substrings
    // of other duration formats (e.g. "1h 23m").
    expect(payload.hero.metaLine).toContain('· 2h ·');
    expect(payload.hero.metaLine).not.toContain('· 1h');
  });

  it('uses the Learning… speed-mode badge when the latest revision sources from bootstrap', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    expect(renderInput.pending.hero.headline).toBe('Charging paused — EV unplugged');
    const chipTexts = renderInput.pending.hero.chips.map((chip) => chip.text);
    expect(chipTexts).toEqual(['EV', 'Paused — unplugged']);
  });

  it('renders the Learning energy use pending hero when the active plan reports missing_capacity', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Bathroom heater',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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

describe('resolveDeadlineHeroTone', () => {
  it('maps cannot_meet to alert so the rim agrees with the Cannot-finish chip', async () => {
    const { resolveDeadlineHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveDeadlineHeroTone('cannot_meet')).toBe('alert');
  });

  it('maps at_risk to warn so an amber rim flags a recoverable shortfall', async () => {
    const { resolveDeadlineHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveDeadlineHeroTone('at_risk')).toBe('warn');
  });

  it('maps on_track and satisfied to good so a healthy plan reads green', async () => {
    const { resolveDeadlineHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveDeadlineHeroTone('on_track')).toBe('good');
    expect(resolveDeadlineHeroTone('satisfied')).toBe('good');
  });

  it('maps invalid to info — the planner could not produce a valid plan, neutral rim', async () => {
    const { resolveDeadlineHeroTone } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveDeadlineHeroTone('invalid')).toBe('info');
  });
});

describe('buildHeroChips', () => {
  const labels = deadlineLabels('temperature');

  it('omits any live-state chip — the active hero no longer renders state on the chip row', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const chips = buildHeroChips({
      labels,
      statusChip: null,
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
      statusChip: { text: labels.cannotMeetChipLabel, tone: 'alert' },
      confidenceChipText: null,
    });
    expect(chips.some((chip) => chip.text === labels.cannotMeetChipLabel && chip.tone === 'alert')).toBe(true);
    expect(chips.map((chip) => chip.text)).toEqual([
      labels.kindChipLabel,
      labels.cannotMeetChipLabel,
    ]);
  });

  it('keeps the canonical chip order kind → status → confidence when all are present', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const chips = buildHeroChips({
      labels,
      statusChip: { text: labels.cannotMeetChipLabel, tone: 'alert' },
      confidenceChipText: 'Estimating',
    });
    expect(chips.map((chip) => chip.text)).toEqual([
      labels.kindChipLabel,
      labels.cannotMeetChipLabel,
      'Estimating',
    ]);
  });

  it('honours the supplied status chip text and tone', async () => {
    const { buildHeroChips } = await import('../src/ui/deadlinePlanHero.ts');
    const alertChips = buildHeroChips({
      labels,
      statusChip: { text: labels.cannotMeetChipLabel, tone: 'alert' },
      confidenceChipText: null,
    });
    expect(alertChips.find((chip) => chip.text === labels.cannotMeetChipLabel)?.tone).toBe('alert');
    const warnChips = buildHeroChips({
      labels,
      statusChip: { text: labels.atRiskChipLabel, tone: 'warn' },
      confidenceChipText: null,
    });
    expect(warnChips.find((chip) => chip.text === labels.atRiskChipLabel)?.tone).toBe('warn');
  });
});

describe('resolveHeroStatusChip', () => {
  const labels = deadlineLabels('temperature');

  it('uses Cannot finish for true cannot-meet heroes', async () => {
    const { resolveHeroStatusChip } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroStatusChip({ labels, planStatus: 'cannot_meet' })).toEqual({
      text: labels.cannotMeetChipLabel,
      tone: 'alert',
    });
  });

  it('uses At risk for recoverable at-risk heroes so detail and list agree', async () => {
    const { resolveHeroStatusChip } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroStatusChip({ labels, planStatus: 'at_risk' })).toEqual({
      text: labels.atRiskChipLabel,
      tone: 'warn',
    });
  });

  it('suppresses the status chip for healthy live heroes', async () => {
    const { resolveHeroStatusChip } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroStatusChip({ labels, planStatus: 'on_track' })).toBeNull();
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

describe('energy estimate range (expected…planned, end-to-end through buildObjectivePayload)', () => {
  const setup = (options: {
    energyExpectedKWh?: number;
    planStatus?: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied';
    // Drives the cold-start chip via the active-plan provenance snapshot —
    // mirrors how the producer pipeline gates the `Estimating` / `Refining`
    // chip on `resolveSmartTaskLearning(plan.kwhPerUnitProvenance)`.
    coldStartProvenance?: boolean;
  } = {}) => {
    const { energyExpectedKWh, planStatus = 'on_track', coldStartProvenance = false } = options;
    const now = new Date(2026, 0, 1, 12, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
      currentTemperature: 18,
      planningPowerKw: 2,
      targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 80, step: 0.5 }],
    }];
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        prices: Array.from({ length: 10 }, (_, offset) => ({
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
    const activePlan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1, 2, 3, 4],
      plannedKWhPerHour: 2,
      targetTemperatureC: 65,
      energyNeededKWh: 10,
      ...(energyExpectedKWh !== undefined ? { energyExpectedKWh } : {}),
      planStatus,
    });
    if (coldStartProvenance) {
      // Bootstrap-sourced provenance with zero accepted samples is the
      // textbook cold-start state — `resolveSmartTaskLearning` returns true
      // and the `Estimating` chip will be emitted for at-risk / queued
      // heroes alongside `low` confidence.
      activePlan.kwhPerUnitProvenance = {
        source: 'bootstrap',
        kWhPerUnit: null,
        acceptedSamples: 0,
        confidence: 'low',
        lastAcceptedAtMs: null,
      };
    }
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true, kind: 'temperature', enforcement: 'soft',
            targetTemperatureC: 65, deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, activePlan);
    return expectOk(testExports.buildObjectivePayload({
      bootstrap, deviceId: 'heater', devices, prices, nowMs: now.getTime(),
    }));
  };

  it('renders the expected…planned range when a buffer is booked', () => {
    const payload = setup({ energyExpectedKWh: 8 }); // expected 8, planned (booked) 10
    expect(payload.hero.metaLine).toContain('8.0–10.0 kWh');
  });

  it('collapses to a single figure when expected equals planned (or is absent)', () => {
    const collapsed = setup({ energyExpectedKWh: 10 });
    expect(collapsed.hero.metaLine).toContain('10.0 kWh');
    expect(collapsed.hero.metaLine).not.toContain('–');

    const legacy = setup({}); // pre-buffer plan: no expected figure
    expect(legacy.hero.metaLine).toContain('10.0 kWh');
  });
});

describe('resolveLiveHeroConfidenceChipText', () => {
  it('suppresses low-confidence copy for true cannot-meet heroes', async () => {
    const { resolveLiveHeroConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveLiveHeroConfidenceChipText({
      confidence: 'low',
      planStatus: 'cannot_meet',
      learning: true,
    })).toBeNull();
  });

  it('keeps low-confidence copy for at-risk heroes that are still learning', async () => {
    const { resolveLiveHeroConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveLiveHeroConfidenceChipText({
      confidence: 'low',
      planStatus: 'at_risk',
      learning: true,
    })).toBe('Estimating');
  });

  it('stays silent on on_track even while learning (the steady case carries no signal)', async () => {
    const { resolveLiveHeroConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveLiveHeroConfidenceChipText({
      confidence: 'low',
      planStatus: 'on_track',
      learning: true,
    })).toBeNull();
  });

  it('suppresses the chip for a learned (not cold-start) rate even at low confidence', async () => {
    const { resolveLiveHeroConfidenceChipText } = await import('../src/ui/deadlinePlanHero.ts');
    // A learned thermal rate sits at `low` confidence forever from inherent
    // variance — that is not an "estimating" state and must not nag.
    expect(resolveLiveHeroConfidenceChipText({
      confidence: 'low',
      planStatus: 'at_risk',
      learning: false,
    })).toBeNull();
  });
});

// `resolveHeroHeadline` gates the live hero headline on rim tone (not on
// the broader cannot-meet flag): at-risk heroes keep their live-state
// headline when a scheduled hour exists, `tone === 'alert'` collapses to
// null, and an at-risk plan with no scheduled hour (`feasible_above_floor`)
// also collapses to null so it can't read "On track" above an amber card.
// See `notes/ui-terminology.md` and the comment above the function in
// `deadlinePlanHero.ts`.
describe('resolveHeroHeadline', () => {
  const labels = deadlineLabels('temperature');
  const HOUR_MS = 60 * 60 * 1000;
  // Use local-time construction so the formatter (which renders local HH:MM)
  // matches a deterministic 16:00 regardless of host timezone.
  const queuedHourStartsAtMs = new Date(2026, 0, 1, 16, 0, 0, 0).getTime();
  const queuedHour = {
    startsAtMs: queuedHourStartsAtMs,
    endMs: queuedHourStartsAtMs + HOUR_MS,
    price: 0,
    plannedOtherKWh: 0,
  };

  it('suppresses the headline only on alert (cannot-finish) heroes', async () => {
    const { resolveHeroHeadline } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroHeadline({
      labels,
      firstChargingHour: queuedHour,
      nowMs: queuedHour.startsAtMs - 60_000,
      tone: 'alert',
    })).toBeNull();
  });

  it('preserves the "from HH:MM" live-state headline on at-risk heroes', async () => {
    const { resolveHeroHeadline } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroHeadline({
      labels,
      firstChargingHour: queuedHour,
      nowMs: queuedHour.startsAtMs - 60_000,
      tone: 'warn',
    })).toBe('Heating from 16:00');
  });

  it('returns "Heating now" when the first scheduled hour has already started', async () => {
    const { resolveHeroHeadline } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroHeadline({
      labels,
      firstChargingHour: queuedHour,
      nowMs: queuedHour.startsAtMs + 60_000,
      tone: 'good',
    })).toBe('Heating now');
  });

  it('returns the on-track sentinel when no hour is scheduled', async () => {
    const { resolveHeroHeadline } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveHeroHeadline({
      labels,
      firstChargingHour: undefined,
      nowMs: queuedHour.startsAtMs,
      tone: 'good',
    })).toBe('On track — no action needed yet');
  });

  it('suppresses the headline on an at-risk plan with no scheduled hour (feasible_above_floor)', async () => {
    const { resolveHeroHeadline } = await import('../src/ui/deadlinePlanHero.ts');
    // The `feasible_above_floor` verdict yields an at-risk (warn) plan with an
    // empty floor schedule — there is no live state to announce, so the
    // headline must NOT claim "On track" above the amber At-risk card.
    expect(resolveHeroHeadline({
      labels,
      firstChargingHour: undefined,
      nowMs: queuedHour.startsAtMs,
      tone: 'warn',
    })).toBeNull();
  });
});

// `resolveQueuedHeadlineReason` answers "why does my smart task start at HH:MM
// instead of now?" — the line below the queued headline. The resolver
// suppresses itself outside the queued state so the on-track / cannot-meet
// heroes don't render an unrelated reason; the queued cases pick from the
// three primary branches (waiting on prices, daily budget used up, cheaper
// window).
describe('resolveQueuedHeadlineReason', () => {
  const labels = deadlineLabels('temperature');
  const HOUR_MS = 60 * 60 * 1000;
  const firstHourStart = Date.UTC(2026, 0, 1, 8, 0);
  const baseHour = {
    startsAtMs: firstHourStart,
    endMs: firstHourStart + HOUR_MS,
    price: 0,
    plannedOtherKWh: 0,
  };
  const deadlineAtMs = Date.UTC(2026, 0, 1, 16, 0);

  it('returns null when the plan cannot meet (subline is suppressed on cannot-meet heroes)', async () => {
    const { resolveQueuedHeadlineReason } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveQueuedHeadlineReason({
      labels,
      firstChargingHour: baseHour,
      nowMs: baseHour.startsAtMs - 60_000,
      cannotMeet: true,
      deadlineAtMs,
      computedFromPricesUpTo: deadlineAtMs,
      dailyBudgetExhaustedInRunUp: false,
    })).toBeNull();
  });

  it('returns null when no charging hour is queued (only "active now" cases reach here)', async () => {
    const { resolveQueuedHeadlineReason } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveQueuedHeadlineReason({
      labels,
      firstChargingHour: undefined,
      nowMs: baseHour.startsAtMs - 60_000,
      cannotMeet: false,
      deadlineAtMs,
      computedFromPricesUpTo: deadlineAtMs,
      dailyBudgetExhaustedInRunUp: false,
    })).toBeNull();
  });

  it('surfaces "Waiting for tomorrow\'s prices through HH:MM" when prices don\'t reach the deadline', async () => {
    const { resolveQueuedHeadlineReason } = await import('../src/ui/deadlinePlanHero.ts');
    const out = resolveQueuedHeadlineReason({
      labels,
      firstChargingHour: baseHour,
      nowMs: baseHour.startsAtMs - 60_000,
      cannotMeet: false,
      deadlineAtMs,
      computedFromPricesUpTo: deadlineAtMs - 60 * 60 * 1000,
      dailyBudgetExhaustedInRunUp: false,
    });
    expect(out).toMatch(/Waiting for tomorrow.s prices/);
  });

  it('surfaces "Today\'s budget is full" when prices are complete but the run-up hit the cap', async () => {
    const { resolveQueuedHeadlineReason } = await import('../src/ui/deadlinePlanHero.ts');
    const out = resolveQueuedHeadlineReason({
      labels,
      firstChargingHour: baseHour,
      nowMs: baseHour.startsAtMs - 60_000,
      cannotMeet: false,
      deadlineAtMs,
      computedFromPricesUpTo: deadlineAtMs,
      dailyBudgetExhaustedInRunUp: true,
    });
    expect(out).toMatch(/Today.s budget is full/);
  });

  it('falls through to "Cheaper than now — starts at HH:MM" when the window was a price choice', async () => {
    const { resolveQueuedHeadlineReason } = await import('../src/ui/deadlinePlanHero.ts');
    const out = resolveQueuedHeadlineReason({
      labels,
      firstChargingHour: baseHour,
      nowMs: baseHour.startsAtMs - 60_000,
      cannotMeet: false,
      deadlineAtMs,
      computedFromPricesUpTo: deadlineAtMs,
      dailyBudgetExhaustedInRunUp: false,
    });
    expect(out).toMatch(/Cheaper than now — starts at/);
  });
});

// `resolveCannotMeetRecourse` picks the action button surfaced under the
// cannot-finish hero body. Daily-budget cause → Budget tab; every other
// cannot-meet cause → Overview tab. The producer resolves the slug so the
// view never branches on raw cause codes.
describe('resolveCannotMeetRecourse', () => {
  const labels = deadlineLabels('temperature');

  it('returns null when the hero is not cannot-meet', async () => {
    const { resolveCannotMeetRecourse } = await import('../src/ui/deadlinePlanHero.ts');
    expect(resolveCannotMeetRecourse({
      labels,
      cannotMeet: false,
      dailyBudgetExhausted: false,
      deviceId: 'heater',
    })).toBeNull();
  });

  it('routes daily-budget-exhausted to "Open Budget" without a deviceId (no overlay to open)', async () => {
    const { resolveCannotMeetRecourse } = await import('../src/ui/deadlinePlanHero.ts');
    const out = resolveCannotMeetRecourse({
      labels,
      cannotMeet: true,
      dailyBudgetExhausted: true,
      deviceId: 'heater',
    });
    expect(out?.label).toBe('Open Budget');
    expect(out?.targetTab).toBe('budget');
    // Budget branch has no device-settings overlay — `deviceId` stays absent
    // so the click dispatcher's `length > 0` guard keeps the click on Budget.
    expect(out?.deviceId).toBeUndefined();
  });

  it('routes every other cannot-meet cause to "Adjust device" with the active task deviceId', async () => {
    const { resolveCannotMeetRecourse } = await import('../src/ui/deadlinePlanHero.ts');
    const out = resolveCannotMeetRecourse({
      labels,
      cannotMeet: true,
      dailyBudgetExhausted: false,
      deviceId: 'heater',
    });
    expect(out?.label).toBe('Adjust device');
    expect(out?.targetTab).toBe('overview');
    // Device-side branch carries the deviceId so the click dispatcher can
    // deep-link the device-settings overlay after landing on Overview.
    expect(out?.deviceId).toBe('heater');
  });

  it('emits an empty deviceId when none is available (cold-start / history-detail-only state)', async () => {
    // Defensive: the dispatcher's `length > 0` guard already degrades to a
    // tab-only landing in this case, but the producer must not synthesise a
    // bogus id either. Empty string is the agreed degraded value, mirroring
    // the history-detail `recourse.deviceId ?? ''` JSX expression.
    const { resolveCannotMeetRecourse } = await import('../src/ui/deadlinePlanHero.ts');
    const out = resolveCannotMeetRecourse({
      labels,
      cannotMeet: true,
      dailyBudgetExhausted: false,
      deviceId: '',
    });
    expect(out?.label).toBe('Adjust device');
    expect(out?.targetTab).toBe('overview');
    expect(out?.deviceId).toBe('');
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
    priceValues: number[] = [],
  ): import('../src/ui/views/DeadlinePlan.tsx').DeadlinePlanPayload => {
    const labels = deadlineLabels('ev_soc');
    return {
      kind: 'ev_soc',
      labels,
      priceUnitLabel: 'øre/kWh',
      hero: {
        chips: [],
        tone: 'good',
        sectionLabel: 'EV smart task',
        headline: 'On track',
        headlineReason: null,
        subline: '',
        metaLine: '',
        costMetaLine: null,
        deliveredSoFarLine: null,
        recourse: null,
      },
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
            price: (priceValues[i] ?? 100).toFixed(2),
            priceValue: priceValues[i] ?? 100,
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
        cheapestHoursCaption: null,
      },
      planInputs: {
        perUnitRateLabel: null,
        perUnitRateNote: null,
        maxPowerLabel: null,
        maxPowerNote: null,
        extraPermissionsValue: null,
        provenanceRows: [],
      },
      revisionLog: [], revisionSummary: { text: null, count: 0, shouldShowPanel: false },
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

  it('zero-anchors the price axis even when all prices are above zero', async () => {
    const { buildChartOption } = await import('../src/ui/views/DeadlinePlan.tsx');
    const payload = buildMinimalPayload([
      { originalDeviceKwh: 5, deviceKwh: 5 },
      { originalDeviceKwh: 5, deviceKwh: 5 },
    ], [0.72, 1.31]);
    const option = buildChartOption(payload, stubPalette, stubTypography) as {
      yAxis: Array<{ min?: number; max?: number; axisLabel?: { formatter?: (value: number) => string } }>;
    };
    expect(option.yAxis[0]?.min).toBe(0);
    expect(option.yAxis[0]?.max).toBe(1.31);
    expect(option.yAxis[0]?.axisLabel?.formatter?.(0.72)).toBe('');
  });

  it('keeps negative price hours visible below zero', async () => {
    const { buildChartOption } = await import('../src/ui/views/DeadlinePlan.tsx');
    const payload = buildMinimalPayload([
      { originalDeviceKwh: 5, deviceKwh: 5 },
      { originalDeviceKwh: 5, deviceKwh: 5 },
    ], [-0.23, 0.41]);
    const option = buildChartOption(payload, stubPalette, stubTypography) as {
      yAxis: Array<{ min?: number; max?: number; axisLabel?: { formatter?: (value: number) => string } }>;
    };
    expect(option.yAxis[0]?.min).toBe(-0.23);
    expect(option.yAxis[0]?.max).toBe(0.41);
    expect(option.yAxis[0]?.axisLabel?.formatter?.(-0.23)).toBe('-0.2');
  });
});

// Cost + delivered-so-far hero lines (v2.7.2 PR 2). Four branches cover the
// chip-row state surface — queued (firstHour in future), on-track (no
// delivery yet), at-risk (`tone === 'warn'`), cannot-meet (`tone === 'alert'`).
// Each branch asserts the planned cost meta line shape and the delivered-so-
// far line shape, plus the `≈` glyph convention.
describe('cost + delivered-so-far hero lines', () => {
  // Stub combined prices keep the cost-display divisor at 100 (`kr` scheme),
  // so raw `total` values in øre/kWh divide to kr/kWh for the cost sums.
  const buildStubPrices = (now: Date, hourCount: number, totalOre: number): SettingsUiPricesPayload => ({
    combinedPrices: {
      priceScheme: 'norway',
      priceUnit: 'kr',
      prices: Array.from({ length: hourCount }, (_, offset) => ({
        startsAt: atLocalHour(now, offset).toISOString(),
        total: totalOre,
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
  });

  const buildStubBootstrap = (
    now: Date,
    deadline: Date,
    plan: DeferredObjectiveActivePlanV1,
    targetTemperatureC: number,
    deviceBuckets?: Record<string, number>,
  ): SettingsUiBootstrap => {
    const bootstrap = buildBootstrap({
      capacity_limit_kw: 8,
      deferred_objectives: {
        version: 1,
        objectivesByDeviceId: {
          heater: {
            enabled: true,
            kind: 'temperature',
            enforcement: 'soft',
            targetTemperatureC,
            deadlineAtMs: deadline.getTime(),
          },
        },
      },
    }, plan);
    if (deviceBuckets) {
      bootstrap.power.tracker = { ...bootstrap.power.tracker, deviceBuckets: { heater: deviceBuckets } };
    }
    return bootstrap;
  };

  const buildHeaterDevice = (currentTemperature: number): DecoratedDeviceSnapshot[] => ([{
    id: 'heater',
    name: 'Connected 300',
    binaryControl: { on: false },
    currentTemperature,
    planningPowerKw: 2,
    targets: [{ id: 'target_temperature', unit: 'C', min: 5, max: 80, step: 0.5 }],
  }]);

  it('queued: no delivery yet — cost line shows planned-only, delivered-so-far shows now/target', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const prices = buildStubPrices(now, 6, 150); // 150 øre/kWh → 1.50 kr/kWh
    const plan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [3, 4], // future hours — queued
      plannedKWhPerHour: 2,
      targetTemperatureC: 22,
      planStatus: 'on_track',
    });
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(now, deadline, plan, 22),
      deviceId: 'heater',
      devices: buildHeaterDevice(18),
      prices,
      nowMs: now.getTime(),
    }));
    // 2 hours × 2 kWh × 1.50 kr/kWh = 6.00 kr planned, no delivery.
    expect(payload.hero.costMetaLine).toBe('Cost ≈ 6.00 kr');
    expect(payload.hero.deliveredSoFarLine).toBe('Delivered 0.0 of 4.0 kWh · now 18.0 °C of 22.0 °C target');
  });

  it('on-track: partial delivery — cost line shows so-far + planned, delivered shows start → current', () => {
    // Plan revised an hour ago so the horizon window starts before `now` and
    // includes the past hour where delivery already happened. Mirrors the
    // real-world lifecycle: a smart task placed earlier, "now" mid-run.
    const planAnchor = new Date(2026, 0, 1, 12, 0, 0, 0);
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(planAnchor, 6); // 18:00 local
    // 6 hours of prices anchored at planAnchor (12:00, 13:00, …, 17:00) so
    // both past (12:00) and future (13:00+) hours land in the horizon.
    const prices = buildStubPrices(planAnchor, 6, 200);
    const plan = buildHeaterActivePlan({
      now: planAnchor,
      deadline,
      plannedHourOffsets: [0, 1, 2, 3], // 12:00, 13:00, 14:00, 15:00 from planAnchor
      plannedKWhPerHour: 1,
      targetTemperatureC: 22,
      energyNeededKWh: 4,
      planStatus: 'on_track',
    });
    // 1 kWh delivered an hour ago (the 12:00 bucket).
    const pastBucketKey = planAnchor.toISOString();
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(planAnchor, deadline, plan, 22, { [pastBucketKey]: 1 }),
      deviceId: 'heater',
      devices: buildHeaterDevice(19),
      prices,
      nowMs: now.getTime(),
    }));
    // Delivered: 1 kWh × 2.00 kr/kWh = 2.00 kr so far · 4 kWh × 2.00 = 8.00 kr planned.
    expect(payload.hero.costMetaLine).toBe('Cost ≈ 2.00 kr so far · 8.00 kr planned');
    // start = 19 − 1 × (3/4) = 18.25; current = 19; target = 22.
    expect(payload.hero.deliveredSoFarLine).toBe('Delivered 1.0 of 4.0 kWh · 18.3 °C → 19.0 °C of 22.0 °C target');
  });

  it('prorates the plan-start hour bucket so pre-plan usage does not inflate delivered totals', () => {
    // Regression: device buckets are full-hour aggregates. If a plan starts
    // mid-hour (e.g. 12:30) and the 12:00 bucket has 1.0 kWh, all of that
    // kWh would otherwise count as "delivered so far" — but half of it
    // happened before the plan existed. The resolver now prorates the
    // bucket that contains `startedAtMs` by the post-start fraction, and
    // skips buckets fully before the plan start.
    const planAnchor = new Date(2026, 0, 1, 12, 30, 0, 0); // plan starts 12:30
    const hourBucket = new Date(2026, 0, 1, 12, 0, 0, 0); // bucket key is hour-start
    const now = new Date(2026, 0, 1, 13, 30, 0, 0);
    const deadline = atLocalHour(planAnchor, 6);
    const prices = buildStubPrices(hourBucket, 7, 200); // 2.00 kr/kWh, anchored at 12:00
    const plan = buildHeaterActivePlan({
      now: planAnchor,
      deadline,
      plannedHourOffsets: [0, 1, 2, 3], // 12:30 → 16:30, but planned hours align to top-of-hour
      plannedKWhPerHour: 1,
      targetTemperatureC: 22,
      energyNeededKWh: 4,
      planStatus: 'on_track',
    });
    // 1.0 kWh recorded in the 12:00 bucket. Half occurred before plan start
    // at 12:30, so only 0.5 kWh should count as delivered.
    const bucketKey = hourBucket.toISOString();
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(planAnchor, deadline, plan, 22, { [bucketKey]: 1 }),
      deviceId: 'heater',
      devices: buildHeaterDevice(19),
      prices,
      nowMs: now.getTime(),
    }));
    // Delivered: 0.5 kWh × 2.00 kr/kWh = 1.00 kr so far (not 2.00).
    expect(payload.hero.costMetaLine).toBe('Cost ≈ 1.00 kr so far · 8.00 kr planned');
    expect(payload.hero.deliveredSoFarLine).toMatch(/Delivered 0\.5 of 4\.0 kWh/);
  });

  it('at-risk: keeps on-track-shape delivered line — the chip warns, the line stays hopeful', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 4);
    const prices = buildStubPrices(now, 4, 100);
    const plan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1, 2, 3],
      plannedKWhPerHour: 2,
      targetTemperatureC: 30,
      energyNeededKWh: 8,
      planStatus: 'at_risk',
    });
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(now, deadline, plan, 30),
      deviceId: 'heater',
      devices: buildHeaterDevice(18),
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.hero.tone).toBe('warn');
    expect(payload.hero.chips.some((chip) => chip.text === 'At risk' && chip.tone === 'warn')).toBe(true);
    expect(payload.hero.chips.some((chip) => chip.text === 'Cannot finish')).toBe(false);
    expect(payload.hero.costMetaLine).toBe('Cost ≈ 8.00 kr');
    // No "won't reach by" copy — at-risk still uses the hopeful shape.
    expect(payload.hero.deliveredSoFarLine).not.toMatch(/won.t reach/i);
    expect(payload.hero.deliveredSoFarLine).toMatch(/now 18.0 °C of 30.0 °C target/);
    // At-risk heroes keep their live-state headline ("Heating now" when the
    // first scheduled hour has already started). The chip warns, but the
    // headline answers "what is the device doing right now?" — only true
    // cannot-finish heroes collapse the headline (see the cannot-meet test
    // below).
    expect(payload.hero.headline).toBe('Heating now');
  });

  it('at-risk: queued first hour preserves the "Heating from HH:MM" live-state headline', () => {
    // Regression for at-risk smart-task heroes losing their live-state
    // headline. Producer must split the cannot-meet gate from the at-risk
    // status so the headline collapses only on `tone === 'alert'`.
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const prices = buildStubPrices(now, 6, 100);
    const plan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [3, 4], // queued — first hour starts at 16:00 local
      plannedKWhPerHour: 2,
      targetTemperatureC: 30,
      energyNeededKWh: 4,
      planStatus: 'at_risk',
    });
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(now, deadline, plan, 30),
      deviceId: 'heater',
      devices: buildHeaterDevice(18),
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.hero.tone).toBe('warn');
    // Queued at-risk hero keeps the kind-shaped "from HH:MM" live state.
    expect(payload.hero.headline).toBe('Heating from 16:00');
  });

  it('at-risk: "Adjust device" recourse threads the active task deviceId for the deep-link', () => {
    // Regression for the at-risk hero's "Adjust device" recourse landing on
    // Overview without a deviceId — the dispatcher then had no overlay to
    // open and the user dead-ended on the tab. Producer must thread the
    // active task's deviceId onto the device-side recourse payload so the
    // click closes the panel AND opens the device-settings overlay in one
    // pass (mirrors the history-detail "Review device" pattern).
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 4);
    const prices = buildStubPrices(now, 4, 100);
    const plan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1, 2, 3],
      plannedKWhPerHour: 2,
      targetTemperatureC: 30,
      energyNeededKWh: 8,
      planStatus: 'at_risk',
    });
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(now, deadline, plan, 30),
      deviceId: 'heater',
      devices: buildHeaterDevice(18),
      prices,
      nowMs: now.getTime(),
    }));
    // Device-side branch: the "Adjust device" recourse carries the active
    // task's deviceId so the click dispatcher can deep-link the overlay.
    expect(payload.hero.recourse).not.toBeNull();
    expect(payload.hero.recourse?.label).toBe('Adjust device');
    expect(payload.hero.recourse?.targetTab).toBe('overview');
    expect(payload.hero.recourse?.deviceId).toBe('heater');
  });

  it('cannot-meet: delivered line uses the magnitude-only `still …` stem (no verdict restatement)', () => {
    // Per TODO ~1586 / 2026-05-16 live walk: the alarm verdict is already
    // announced by the alert chip ("Cannot finish") and the meta line ("Not
    // enough time for this target. …"), so the magnitude line drops the
    // `· won't reach by HH:MM` tail it previously carried. The `still` stem
    // (vs the on-track `now`) keeps the tonal pairing with the alert chip
    // without re-asserting the failure a third time. Pairs with the at-risk
    // regression above (which still uses `now …`) to lock the two branches.
    const now = new Date(2026, 0, 1, 14, 0, 0, 0);
    const deadline = atLocalHour(now, 2);
    const prices = buildStubPrices(now, 2, 100);
    const plan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1],
      plannedKWhPerHour: 2,
      targetTemperatureC: 65,
      energyNeededKWh: 16, // far more than 4 kWh allocated → won't reach
      planStatus: 'cannot_meet',
    });
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(now, deadline, plan, 65),
      deviceId: 'heater',
      devices: buildHeaterDevice(40),
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.hero.tone).toBe('alert');
    expect(payload.hero.costMetaLine).toBe('Cost ≈ 4.00 kr'); // 2 hours × 2 kWh × 1.00 kr
    expect(payload.hero.deliveredSoFarLine).toMatch(/Delivered 0\.0 of 16\.0 kWh/);
    expect(payload.hero.deliveredSoFarLine).toMatch(/still 40\.0 °C of 65\.0 °C target/);
    // No "won't reach by" tail — the chip + meta line already say the verdict;
    // repeating it on a third line read as alarm spam in the live walk.
    expect(payload.hero.deliveredSoFarLine).not.toMatch(/won.t reach/i);
    // Cannot-meet keeps the headline suppressed — the Cannot-finish chip and
    // body postmortem already carry the signal; the headline must not duplicate
    // it. Pairs with the at-risk regression above to prove the split gate
    // didn't regress cannot-meet behaviour.
    expect(payload.hero.headline).toBeNull();
  });

  it('suppresses the cost line when the cost unit is empty (Flow / Homey scheme without priceUnit)', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 4);
    const prices: SettingsUiPricesPayload = {
      combinedPrices: {
        priceScheme: 'flow',
        priceUnit: 'price units',
        prices: Array.from({ length: 4 }, (_, offset) => ({
          startsAt: atLocalHour(now, offset).toISOString(),
          total: 1,
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
    const plan = buildHeaterActivePlan({
      now,
      deadline,
      plannedHourOffsets: [0, 1],
      plannedKWhPerHour: 2,
      targetTemperatureC: 22,
      planStatus: 'on_track',
    });
    const payload = expectOk(testExports.buildObjectivePayload({
      bootstrap: buildStubBootstrap(now, deadline, plan, 22),
      deviceId: 'heater',
      devices: buildHeaterDevice(18),
      prices,
      nowMs: now.getTime(),
    }));
    expect(payload.hero.costMetaLine).toBeNull();
    // Delivered-so-far is independent of cost unit and still surfaces.
    expect(payload.hero.deliveredSoFarLine).toMatch(/Delivered 0\.0 of 4\.0 kWh/);
  });
});

// Pure-resolver tests for `formatDeadlineCostMetaLine` /
// `formatDeadlineDeliveredSoFarLine` in shared-domain. The integration tests
// above cover the full producer-to-payload wiring; these guard the resolver
// edges in isolation (empty unit, zero planned, missing progress).
describe('shared-domain hero-line formatters', () => {
  it('formatDeadlineCostMetaLine uses ≈ (U+2248), never ~ or "approx"', async () => {
    const { formatDeadlineCostMetaLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineCostMetaLine({ plannedTotalCost: 6.5, deliveredCost: null, costUnit: 'kr' });
    expect(out).toBe('Cost ≈ 6.50 kr');
    expect(out).toContain('≈');
    expect(out).not.toContain('~');
    expect(out).not.toMatch(/approx/i);
  });

  it('formatDeadlineCostMetaLine collapses to planned-only when delivered is null', async () => {
    const { formatDeadlineCostMetaLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineCostMetaLine({ plannedTotalCost: 6.5, deliveredCost: null, costUnit: 'kr' });
    expect(out).toBe('Cost ≈ 6.50 kr');
  });

  it('formatDeadlineCostMetaLine emits the composite form when delivered > 0', async () => {
    const { formatDeadlineCostMetaLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineCostMetaLine({ plannedTotalCost: 6.5, deliveredCost: 0.3, costUnit: 'kr' });
    expect(out).toBe('Cost ≈ 0.30 kr so far · 6.50 kr planned');
  });

  it('formatDeadlineCostMetaLine returns null when the unit is empty', async () => {
    const { formatDeadlineCostMetaLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: 6.5, deliveredCost: null, costUnit: '' })).toBeNull();
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: 6.5, deliveredCost: null, costUnit: '   ' })).toBeNull();
  });

  it('formatDeadlineCostMetaLine returns null when planned cost is non-finite', async () => {
    const { formatDeadlineCostMetaLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: Number.NaN, deliveredCost: null, costUnit: 'kr' })).toBeNull();
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: Number.POSITIVE_INFINITY, deliveredCost: null, costUnit: 'kr' })).toBeNull();
  });

  it('formatDeadlineCostMetaLine renders zero and negative planned cost (Nordpool can be negative)', async () => {
    // Regression: previously the helper suppressed `<= 0` planned cost,
    // dropping the line during negative-price oversupply windows — the
    // exact pricing regime PELS targets in Norway. The guard now rejects
    // only non-finite values.
    const { formatDeadlineCostMetaLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: 0, deliveredCost: null, costUnit: 'kr' }))
      .toBe('Cost ≈ 0.00 kr');
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: -0.30, deliveredCost: null, costUnit: 'kr' }))
      .toBe('Cost ≈ -0.30 kr');
    expect(formatDeadlineCostMetaLine({ plannedTotalCost: -0.30, deliveredCost: -0.05, costUnit: 'kr' }))
      .toBe('Cost ≈ -0.05 kr so far · -0.30 kr planned');
  });

  it('formatDeadlineDeliveredSoFarLine surfaces the start → current arrow when start is known', async () => {
    const { formatDeadlineDeliveredSoFarLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineDeliveredSoFarLine({
      status: 'on_track_or_queued',
      deliveredKWh: 1.8,
      plannedTotalKWh: 4.2,
      currentProgress: 42,
      startProgress: 35,
      targetValue: 65,
      targetUnit: '°C',
      deadlineTime: '16:00',
    });
    expect(out).toBe('Delivered 1.8 of 4.2 kWh · 35.0 °C → 42.0 °C of 65.0 °C target');
  });

  it('formatDeadlineDeliveredSoFarLine collapses to `now …` when start equals current', async () => {
    const { formatDeadlineDeliveredSoFarLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineDeliveredSoFarLine({
      status: 'on_track_or_queued',
      deliveredKWh: 0,
      plannedTotalKWh: 4.2,
      currentProgress: 42,
      startProgress: null,
      targetValue: 65,
      targetUnit: '°C',
      deadlineTime: '16:00',
    });
    expect(out).toBe('Delivered 0.0 of 4.2 kWh · now 42.0 °C of 65.0 °C target');
  });

  it('formatDeadlineDeliveredSoFarLine suppresses the redundant arrow when start and current round to the same label', async () => {
    // Regression: previously the helper used a numeric `Math.abs(...) > 0.05`
    // gate to decide whether to render `start → current`. For percent
    // (`Math.round`), two readings within ~0.5 percentage points still render
    // identically — producing a meaningless "45% → 45%" arrow. The helper
    // now compares the formatted labels post-rounding and falls through to
    // "now X" when they match.
    const { formatDeadlineDeliveredSoFarLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineDeliveredSoFarLine({
      status: 'on_track_or_queued',
      deliveredKWh: 0.4,
      plannedTotalKWh: 4.2,
      currentProgress: 45.4,
      startProgress: 45.1,
      targetValue: 80,
      targetUnit: '%',
      deadlineTime: '16:00',
    });
    expect(out).toBe('Delivered 0.4 of 4.2 kWh · now 45% of 80% target');
    expect(out).not.toMatch(/45%\s*→\s*45%/);
  });

  it('formatDeadlineDeliveredSoFarLine renders the magnitude-only `still …` stem on cannot-meet', async () => {
    // Per TODO ~1586 / 2026-05-16 live walk: the chip ("Cannot finish") + meta
    // line ("Not enough time for this target …") already carry the verdict, so
    // the magnitude line drops the `· won't reach by HH:MM` tail and stays
    // information-only. The `still` stem (vs the on-track `now`) keeps the
    // tonal pairing with the alert chip without re-asserting the failure.
    const { formatDeadlineDeliveredSoFarLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineDeliveredSoFarLine({
      status: 'cannot_meet',
      deliveredKWh: 1.8,
      plannedTotalKWh: 4.2,
      currentProgress: 35,
      startProgress: null,
      targetValue: 65,
      targetUnit: '°C',
      deadlineTime: '16:00',
    });
    expect(out).toBe('Delivered 1.8 of 4.2 kWh · still 35.0 °C of 65.0 °C target');
    expect(out).not.toMatch(/won.t reach/i);
  });

  it('formatDeadlineDeliveredSoFarLine returns null when planned kWh is zero', async () => {
    const { formatDeadlineDeliveredSoFarLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    expect(formatDeadlineDeliveredSoFarLine({
      status: 'on_track_or_queued',
      deliveredKWh: 0,
      plannedTotalKWh: 0,
      currentProgress: 18,
      startProgress: null,
      targetValue: 22,
      targetUnit: '°C',
      deadlineTime: '16:00',
    })).toBeNull();
  });

  it('formatDeadlineDeliveredSoFarLine formats EV percent without decimals', async () => {
    const { formatDeadlineDeliveredSoFarLine } = await import('../../shared-domain/src/deadlineLabels.ts');
    const out = formatDeadlineDeliveredSoFarLine({
      status: 'on_track_or_queued',
      deliveredKWh: 5,
      plannedTotalKWh: 20,
      currentProgress: 45.6,
      startProgress: 30,
      targetValue: 80,
      targetUnit: '%',
      deadlineTime: '07:00',
    });
    expect(out).toBe('Delivered 5.0 of 20.0 kWh · 30% → 46% of 80% target');
  });
});

// Pure-resolver tests for the pending-hero `headlineReason` + `recourse`
// fields. Mirrors the "shared-domain hero-line formatters" describe block
// above — guards each per-pending-reason branch in isolation so producer
// wiring and resolver copy can be reviewed separately.
describe('shared-domain pending-hero copy', () => {
  it('temperature awaiting_horizon_plan surfaces the deadline horizon in headlineReason and emits no recourse', async () => {
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('temperature').pendingHeroByReason.awaiting_horizon_plan({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_heater',
      deviceName: 'Connected 300',
      deadlineTime: '07:00',
    });
    expect(copy.headlineReason).toBe('Need prices through 07:00 before the smart task can start.');
    expect(copy.recourse).toBeNull();
  });

  it('temperature awaiting_horizon_plan keeps the same headlineReason in external-flow price mode', async () => {
    // Headline + body branch on the price source, but the panic-visitor's
    // "how long am I waiting?" answer is the deadline horizon regardless —
    // hence headlineReason stays stable across the two body shapes.
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('temperature').pendingHeroByReason.awaiting_horizon_plan({
      priceSource: 'external_flow',
      lastFetchedShort: '14:32',
      deviceId: 'dev_heater',
      deviceName: 'Connected 300',
      deadlineTime: '07:00',
    });
    expect(copy.headline).toBe('Waiting for tomorrow’s prices from your Flow');
    expect(copy.headlineReason).toBe('Need prices through 07:00 before the smart task can start.');
    expect(copy.recourse).toBeNull();
  });

  it('temperature device_data_missing names the device in headlineReason and emits an Overview recourse', async () => {
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('temperature').pendingHeroByReason.device_data_missing({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_heater',
      deviceName: 'Connected 300',
      deadlineTime: '07:00',
    });
    expect(copy.headlineReason).toBe('PELS can’t read the current temperature from Connected 300.');
    expect(copy.recourse?.targetTab).toBe('overview');
    expect(copy.recourse?.label).toBe('Open device in Overview');
  });

  it('temperature device_data_missing falls back to "the heater" when the device snapshot has no name', async () => {
    // Empty deviceName covers the pre-load race where the device snapshot
    // hasn't landed yet; the copy must still parse cleanly.
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('temperature').pendingHeroByReason.device_data_missing({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_heater',
      deviceName: '',
      deadlineTime: '07:00',
    });
    expect(copy.headlineReason).toBe('PELS can’t read the current temperature from the heater.');
    expect(copy.recourse?.targetTab).toBe('overview');
  });

  it('exports the canonical one-line missing_capacity copy with an em-dash separator', async () => {
    const { PENDING_REASON_MISSING_CAPACITY_COPY } = await import(
      '../../shared-domain/src/deadlineLabels.ts'
    );
    expect(PENDING_REASON_MISSING_CAPACITY_COPY).toBe(
      'Learning energy use — needs power readings from this device.',
    );
    // Em-dash is the proper Unicode character (U+2014), not two hyphens.
    expect(PENDING_REASON_MISSING_CAPACITY_COPY).toContain('—');
    expect(PENDING_REASON_MISSING_CAPACITY_COPY).not.toContain('--');
  });

  it('temperature missing_capacity collapses to a one-line learning-energy-use copy', async () => {
    const { deadlineLabels, PENDING_REASON_MISSING_CAPACITY_COPY } = await import(
      '../../shared-domain/src/deadlineLabels.ts'
    );
    const copy = deadlineLabels('temperature').pendingHeroByReason.missing_capacity({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_heater',
      deviceName: 'Connected 300',
      deadlineTime: '07:00',
    });
    // Headline + body parse together as the canonical one-line copy
    // (`PENDING_REASON_MISSING_CAPACITY_COPY`) so the user reads the
    // pending hero as a single coherent sentence.
    expect(`${copy.headline} — ${copy.body.replace(/^./, (c) => c.toLowerCase())}`)
      .toBe(PENDING_REASON_MISSING_CAPACITY_COPY);
    expect(copy.body).toBe('Needs power readings from this device.');
    // headlineReason suppressed — the one-line copy is self-contained, so
    // the resolver declines to fabricate extra subline copy that would
    // duplicate the body.
    expect(copy.headlineReason).toBeNull();
    // Recourse lands on Overview where the user can verify the heater is
    // running — per `feedback_hard_cap_is_physical.md` we never suggest
    // raising the global capacity hard cap as a remedy.
    expect(copy.recourse?.targetTab).toBe('overview');
    expect(copy.recourse?.label).not.toMatch(/hard cap/i);
  });

  it('temperature invalid_session falls back to device_data_missing copy (thermal can’t go invalid)', async () => {
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('temperature').pendingHeroByReason.invalid_session({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_heater',
      deviceName: 'Connected 300',
      deadlineTime: '07:00',
    });
    expect(copy.headlineReason).toBe('PELS can’t read the current temperature from Connected 300.');
    expect(copy.recourse?.targetTab).toBe('overview');
  });

  it('ev_soc awaiting_horizon_plan surfaces the deadline horizon in headlineReason', async () => {
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('ev_soc').pendingHeroByReason.awaiting_horizon_plan({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_ev',
      deviceName: 'Garage EV',
      deadlineTime: '07:00',
    });
    expect(copy.headlineReason).toBe('Need prices through 07:00 before the smart task can start.');
    expect(copy.recourse).toBeNull();
  });

  it('ev_soc device_data_missing names the device and reads "state of charge"', async () => {
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('ev_soc').pendingHeroByReason.device_data_missing({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_ev',
      deviceName: 'Garage EV',
      deadlineTime: '07:00',
    });
    expect(copy.headlineReason).toBe('PELS can’t read the state of charge from Garage EV.');
    expect(copy.recourse?.targetTab).toBe('overview');
  });

  it('ev_soc invalid_session restates the charger signal at headline height and emits no recourse', async () => {
    // EV plug-out is a physical action; no in-app tab maps to it, so
    // recourse stays null and the body alone names the unblocking condition.
    const { deadlineLabels } = await import('../../shared-domain/src/deadlineLabels.ts');
    const copy = deadlineLabels('ev_soc').pendingHeroByReason.invalid_session({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'dev_ev',
      deviceName: 'Garage EV',
      deadlineTime: '07:00',
    });
    expect(copy.headline).toBe('Charging paused — EV unplugged');
    expect(copy.headlineReason).toBe('Charger reports the car isn’t plugged in.');
    expect(copy.recourse).toBeNull();
  });
});

// Producer integration: per-pending-reason render path checks that
// `buildPendingPayload` threads deviceName + deadlineTime through to the
// shared-domain resolver and that the view-facing payload carries the new
// fields.
describe('pending hero producer wiring', () => {
  it('threads deviceName + deadlineTime into the pending hero so headlineReason resolves', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      binaryControl: { on: false },
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
    expect(renderInput.pending.hero.headlineReason).toBe(
      'PELS can’t read the current temperature from Connected 300.',
    );
    expect(renderInput.pending.hero.recourse?.targetTab).toBe('overview');
  });

  it('emits no recourse on the EV unplugged pending hero — plugging in is a physical action', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: DecoratedDeviceSnapshot[] = [{
      id: 'ev',
      name: 'Garage EV',
      binaryControl: { on: false },
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
    expect(renderInput.pending.hero.headlineReason).toBe('Charger reports the car isn’t plugged in.');
    expect(renderInput.pending.hero.recourse).toBeNull();
  });
});

describe('pendingChipTone parity with the Smart-tasks list', () => {
  // The Smart-tasks list card (`DeadlinesList.tsx` via
  // `SMART_TASK_LIST_STATUS_CHIP_VARIANT`) and the plan-detail pending hero
  // (`DeadlinePlan.tsx` via `pendingChipTone`) must agree on the chip tone for
  // every pending state. Both now route through the same shared-domain
  // resolvers (`resolveBuildingPlanChipTone` / `resolvePausedUnpluggedChipTone`)
  // so this assertion pins the consumer wiring — if either surface ever
  // recomputes its own tone the test fails before drift reaches users.
  it('emits the list-variant tone for Building plan…', () => {
    expect(pendingChipTone('building_plan'))
      .toBe(SMART_TASK_LIST_STATUS_CHIP_VARIANT.building_plan);
  });

  it('emits the list-variant tone for Paused — unplugged', () => {
    expect(pendingChipTone('paused_unplugged'))
      .toBe(SMART_TASK_LIST_STATUS_CHIP_VARIANT.paused_unplugged);
  });
});
