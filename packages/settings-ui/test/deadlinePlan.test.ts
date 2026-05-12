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

const expectOk = (result: ReturnType<typeof testExports.buildObjectivePayload>) => {
  if (!result || result.kind !== 'ok') {
    throw new Error(`expected buildObjectivePayload ok, got ${result ? result.kind : 'null'}`);
  }
  return result.payload;
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
  energyNeededKWh?: number;
  planStatus?: 'at_risk' | 'cannot_meet' | 'invalid' | 'on_track' | 'satisfied';
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
    energyNeededKWh: params.energyNeededKWh
      ?? params.plannedHourOffsets.length * params.plannedKWhPerHour,
    planStatus: params.planStatus ?? ('on_track' as const),
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
    expect(payload.timeline.hours.some((hour) => hour.planned && hour.price === '10.00')).toBe(true);
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
      expect(payload.timeline.hours[0]?.usage.deviceKwh).toBe(2);
    }
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
      stateOfCharge: { percent: 40, status: 'fresh', source: 'capability' },
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
});
