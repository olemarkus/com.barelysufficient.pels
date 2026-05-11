import { describe, expect, it } from 'vitest';
import { testExports } from '../src/ui/deadlinePlan.ts';
import type { SettingsUiBootstrap, SettingsUiPricesPayload } from '../../contracts/src/settingsUiApi.ts';
import type { DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../contracts/src/deferredObjectiveActivePlans.ts';

const atLocalHour = (base: Date, hourOffset: number): Date => {
  const date = new Date(base);
  date.setHours(date.getHours() + hourOffset, 0, 0, 0);
  return date;
};

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
  targetTemperatureC?: number;
}): DeferredObjectiveActivePlanV1 => {
  const revisedAtMs = params.now.getTime();
  const hours = params.plannedHourOffsets.map((offset) => ({
    startsAtMs: atLocalHour(params.now, offset).getTime(),
    plannedKWh: params.plannedKWhPerHour,
  }));
  const revision = {
    revision: 1,
    revisedAtMs,
    computedFromPricesUpTo: params.deadline.getTime(),
    reason: 'flow_card' as const,
    hours,
  };
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
    original: revision,
    latest: revision,
  };
};

const buildBootstrap = (
  settings: SettingsUiBootstrap['settings'],
  activePlan: DeferredObjectiveActivePlanV1 | null = null,
): SettingsUiBootstrap => ({
  settings,
  dailyBudget: null,
  deferredObjectiveActivePlans: buildActivePlans(activePlan),
  featureAccess: { canToggleOverviewRedesign: true },
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
    const payload = testExports.buildObjectivePayload({
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
    });

    expect(payload?.kind).toBe('temperature');
    expect(payload?.hero.sectionLabel).toBe('Temperature plan');
    expect(payload?.hero.subline).toContain('Connected 300');
    expect(payload?.hero.subline).toContain('22 °C');
    const chipTexts = payload?.hero.chips.map((chip) => chip.text) ?? [];
    expect(new Set(chipTexts).size).toBe(chipTexts.length);
    expect(chipTexts).not.toContain('Charging');
    expect(payload?.timeline.hours).toHaveLength(6);
    const hours = payload?.timeline.hours ?? [];
    expect(hours[hours.length - 1]?.time).toBe(`${String(deadline.getHours() - 1).padStart(2, '0')}:00`);
    expect(payload?.timeline.hours.some((hour) => hour.planned)).toBe(true);
    expect(payload?.timeline.hours.some((hour) => hour.planned && hour.price === '10.00')).toBe(true);
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

    const payload = testExports.buildObjectivePayload({
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
    });

    expect(payload?.hero.metaLine).toContain('Needs 4.0 kWh');
    expect(payload?.timeline.hours.some((hour) => hour.planned)).toBe(true);
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

    const payload = testExports.buildObjectivePayload({
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
    });

    expect(payload?.timeline.hours).toHaveLength(6);
    expect(payload?.timeline.hours.some((hour) => hour.planned)).toBe(true);
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

  it('does not let lower-priority managed load shrink priority 1 allocation', () => {
    const now = new Date(2026, 0, 1, 13, 0, 0, 0);
    const deadline = atLocalHour(now, 6);
    const devices: TargetDeviceSnapshot[] = [{
      id: 'heater',
      name: 'Connected 300',
      currentOn: false,
      currentTemperature: 18,
      planningPowerKw: 2,
      priority: 1,
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
    bootstrap.dailyBudget = buildDailyBudget(now, {
      controlledKWh: 4,
      plannedKWh: 5,
      uncontrolledKWh: 1,
    });

    const payload = testExports.buildObjectivePayload({
      bootstrap,
      deviceId: 'heater',
      devices,
      prices,
      nowMs: now.getTime(),
    });

    expect(payload?.timeline.hours[0]?.usage.backgroundKwh).toBe(1);
    expect(payload?.timeline.hours[0]?.usage.deviceKwh).toBe(2);
  });
});
