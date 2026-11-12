import { describe, expect, it } from 'vitest';
import { createContinuousBatteryPlanSource, type ContinuousBatteryHorizonSources } from '../../lib/battery/continuousBatteryHorizon';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { BatteryControlOwner, BatteryLeverRead } from '../../lib/ports/batteryControlOwner';
import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import type { ContinuousBatteryHorizonRead } from '../../lib/ports/continuousBatteryPlan';
import type { DeferredObjectiveActivePlansV2, DeferredObjectiveActivePlanV1, DeferredObjectiveActivePlanRevisionV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import { ObjectiveTaskReservationSource } from '../../lib/objectives/deferredObjectives/taskReservationSource';
import { buildObjectiveSignatureForEntry } from '../../lib/objectives/deferredObjectives/activePlanSignature';
import type { ObjectiveDeviceSource } from '../../lib/objectives/types';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.parse('2026-10-27T00:00:00Z');
const HOUR_MS = 3_600_000;
const config: ContinuousBatteryPlanConfig = {
  enabled: true, usableCapacityKWh: 10, minimumReservePercent: 20,
  roundTripEfficiency: 0.9, wearCostPerKWh: 0.03, priceUnit: 'EUR/kWh',
  exportPolicy: { kind: 'household_only' },
};
const control: BatteryLeverRead = {
  kind: 'setpoint', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
  deliveryCeilingW: 2500, chargeCeiling: { everyLevelW: 2500, taper: [], planningTaper: [] }, claimHeld: false, handBackDeferred: false,
  claimEngaged: false, keepAliveFor: () => ({ kind: 'none' }), response: { kind: 'delivers_setpoint' }, admissible: true, verdict: 'responding',
};

const taskObjective = (deadlineAtMs: number): DeferredObjectiveSettingsEntry => ({
  kind: 'energy', enabled: true, targetEnergyKWh: 1, enforcement: 'soft', deadlineAtMs,
});

const sources = (overrides: Partial<ContinuousBatteryHorizonSources> & {
  getActiveTasks?: () => DeferredObjectiveActivePlansV2;
} = {}): ContinuousBatteryHorizonSources => ({
  getNowMs: () => NOW,
  getDevices: () => [partialDouble<DeviceSurfaces>({
    id: 'battery', managed: true, available: true, isBatteryOrSolar: true,
    batteryLevel: { percent: 40, observedAtMs: NOW }, batteryPower: { signedW: 0, observedAtMs: NOW },
  }), partialDouble<DeviceSurfaces>({ id: 'ev', managed: true, isBatteryOrSolar: false })],
  getControl: () => partialDouble<BatteryControlOwner>({ readControl: () => control }),
  getControllableDevices: () => ({}),
  getPrioritiesForDevices: (deviceIds) => ({ getPriority: (deviceId) => deviceIds.indexOf(deviceId) }),
  getPriceTimeline: () => ({
    state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: false,
    lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
    periods: [{ startsAt: new Date(NOW).toISOString(), durationMinutes: 60, importPrice: 0.2, level: 'normal' }],
  }),
  getPowerLimitSettings: () => ({ limitKw: 5, marginKw: 0, periodMinutes: 60, capacityEnabled: true, gridImportLimitKw: null }),
  taskReservations: new ObjectiveTaskReservationSource({
    getDeferredObjectiveActivePlans: () => overrides.getActiveTasks?.() ?? { version: 2, plansByDeviceId: {} },
    getCapacitySettings: () => ({ limitKw: 5, marginKw: 0, periodMinutes: 60, capacityEnabled: true, gridImportLimitKw: null }),
    getThermalDirection: () => 'heating',
  }, () => ({
    objectivesByDeviceId: Object.fromEntries(Object.entries(overrides.getActiveTasks?.().plansByDeviceId ?? {})
      .map(([deviceId, plan]) => [deviceId, taskObjective(plan.deadlineAtMs)])),
  }), () => [], (device: ObjectiveDeviceSource) => device),
  solarScope: { mainDevices: () => [], allDevices: () => [] },
  getSolarForecast: () => ({ forecast: () => [] }),
  getBackgroundKWh: () => 0.5,
  ...overrides,
});

const task = (plannedKWh: number, startMs = NOW, endMs = NOW + HOUR_MS): DeferredObjectiveActivePlanV1 => (
  partialDouble<DeferredObjectiveActivePlanV1>({
    deviceId: 'ev', deadlineAtMs: endMs, pending: false, objectiveKind: 'energy',
    objectiveSignature: buildObjectiveSignatureForEntry(taskObjective(endMs), 'increasing'),
    commitment: { committedAtMs: NOW, hours: [] },
    liveCompletion: { kind: 'unmet', status: 'on_track' },
    latest: partialDouble<DeferredObjectiveActivePlanRevisionV1>({
      hours: [], reservationSegments: [{ startMs, endMs, plannedKWh, plannedAdmissionPowerKw: 7 }],
    }),
  })
);

/** One battery's horizon, read the way the plan owner reads every enabled battery. */
const horizonSource = (input: ContinuousBatteryHorizonSources) => {
  const source = createContinuousBatteryPlanSource(input);
  return {
    readHorizon: (deviceId: string, batteryConfig: ContinuousBatteryPlanConfig): ContinuousBatteryHorizonRead => {
      const read = source.readHorizons(source.getNowMs(), [{ deviceId, config: batteryConfig }]).get(deviceId);
      if (read === undefined) throw new Error('Expected a horizon read');
      return read;
    },
  };
};

describe('continuous battery horizon projection', () => {
  it('cannot plan a battery excluded by the main-home membership owner', () => {
    expect(horizonSource(sources({ getDevices: () => [] })).readHorizon('battery', config))
      .toEqual({ kind: 'waiting', reason: 'control_unavailable' });
  });

  it.each(['not_responding', 'sign_inverted'] as const)(
    'leaves a battery out of the plan once its control is judged %s, so the others plan for the house',
    (verdict) => {
      const judged: BatteryLeverRead = { ...control, verdict };
      expect(horizonSource(sources({
        getControl: () => partialDouble<BatteryControlOwner>({ readControl: () => judged }),
      })).readHorizon('battery', config)).toEqual({ kind: 'waiting', reason: 'control_unavailable' });
    },
  );

  it('plans a home without solar from resolved absence, without inventing a solar forecast', () => {
    const result = horizonSource(sources()).readHorizon('battery', config);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods[0].solarKWh).toBe(0);
    expect(result.horizon.periods[0].householdDemandKWh).toBe(0.5);
    expect(result.exportPricing).toBe('incomplete');
  });

  it('carries the planning taper as stored-energy steps, not the live one', () => {
    const tapered: BatteryLeverRead = {
      ...control,
      chargeCeiling: {
        everyLevelW: 2000,
        taper: [],
        planningTaper: [{ fromPercent: 90, ceilingW: 3000 }, { fromPercent: 95, ceilingW: 600 }],
      },
    };
    const result = horizonSource(sources({
      getControl: () => partialDouble<BatteryControlOwner>({ readControl: () => tapered }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.battery.maxChargeKW).toBe(2);
    expect(result.horizon.battery.chargeTaper).toEqual([
      { fromEnergyKWh: 9, maxChargeKW: 2.5 },
      { fromEnergyKWh: 9.5, maxChargeKW: 0.6 },
    ]);
  });

  it.each([0, -0.1, 0.1])('recognizes an actual export quote of %s without solar', (exportPrice) => {
    const base = sources();
    const result = horizonSource(sources({
      getPriceTimeline: () => {
        const timeline = base.getPriceTimeline();
        if (timeline.state !== 'ready') throw new Error('Expected fixture prices');
        return { ...timeline, periods: timeline.periods.map(period => ({ ...period, exportPrice })) };
      },
    })).readHorizon('battery', config);
    expect(result).toMatchObject({ kind: 'ready', exportPricing: 'complete' });
  });

  it('requires export quotes throughout the actual contiguous horizon, ignoring expired periods', () => {
    const base = sources();
    let quotePublished = false;
    const source = horizonSource(sources({
      getNowMs: () => NOW + HOUR_MS / 8,
      getPriceTimeline: () => {
        const timeline = base.getPriceTimeline();
        if (timeline.state !== 'ready') throw new Error('Expected fixture prices');
        const first = timeline.periods[0];
        return { ...timeline, periods: [
          { ...first, startsAt: new Date(NOW - HOUR_MS).toISOString() },
          { ...first, durationMinutes: 15, exportPrice: 0.2 },
          { ...first, startsAt: new Date(NOW + HOUR_MS / 4).toISOString(), durationMinutes: 15,
            ...(quotePublished ? { exportPrice: 0 } : {}) },
          // A gap terminates the existing horizon. This later quote cannot extend it.
          { ...first, startsAt: new Date(NOW + HOUR_MS).toISOString(), exportPrice: 1 },
        ] };
      },
    }));
    const incomplete = source.readHorizon('battery', config);
    expect(incomplete).toMatchObject({ kind: 'ready', exportPricing: 'incomplete' });
    quotePublished = true;
    const complete = source.readHorizon('battery', config);
    if (complete.kind !== 'ready') throw new Error('Expected horizon');
    expect(complete.exportPricing).toBe('complete');
    expect(complete.horizon.periods.map(period => period.durationMs)).toEqual([HOUR_MS / 8, HOUR_MS / 4]);
    expect(complete.horizon.periods.map(period => period.exportPrice)).toEqual([0.2, 0]);
  });

  it('ignores PV outside Main and waits when an aggregate cannot separate Main and foreign PV', () => {
    const pv = { id: 'pv', deviceClass: 'solarpanel' };
    const foreign = { id: 'foreign-pv', deviceClass: 'solarpanel' };
    const getSolarForecast = () => { throw new Error('A foreign aggregate must not be consumed'); };
    const withoutMain = horizonSource(sources({
      solarScope: { mainDevices: () => [], allDevices: () => [foreign] }, getSolarForecast,
    })).readHorizon('battery', config);
    if (withoutMain.kind !== 'ready') throw new Error('Main has no solar');
    expect(withoutMain.horizon.periods[0].solarKWh).toBe(0);
    expect(horizonSource(sources({
      solarScope: { mainDevices: () => [pv], allDevices: () => [pv, foreign] }, getSolarForecast,
    })).readHorizon('battery', config)).toEqual({ kind: 'waiting', reason: 'solar_scope_shared' });
  });

  it('keeps economic EV energy separate from the physical charging reservation', () => {
    const result = horizonSource(sources({
      getActiveTasks: () => ({ version: 2, plansByDeviceId: { ev: task(0.5) } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods[0].otherManagedDemandKWh).toBe(0.5);
    expect(result.horizon.periods[0].maxChargeKW).toBe(0);
    expect(result.horizon.periods[0].gridImportLimitKW).toBe(5);
  });

  it('keeps a native quarter booking inside its bounds when reservation segments were not saved', () => {
    const scheduled = { ...task(0.5), latest: partialDouble<DeferredObjectiveActivePlanRevisionV1>({
      hours: [{ startsAtMs: NOW + HOUR_MS / 4, endsAtMs: NOW + HOUR_MS / 2,
        plannedKWh: 0.5, plannedAdmissionPowerKw: 7 }],
    }) };
    const result = horizonSource(sources({
      getActiveTasks: () => ({ version: 2, plansByDeviceId: { ev: scheduled } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods.map(period => period.startsAtMs)).toEqual([
      NOW, NOW + HOUR_MS / 4, NOW + HOUR_MS / 2,
    ]);
    expect(result.horizon.periods.map(period => period.otherManagedDemandKWh)).toEqual([0, 0.5, 0]);
    expect(result.horizon.periods.map(period => period.maxChargeKW)).toEqual([4.5, 0, 4.5]);
  });

  it.each(['unmanaged', 'other_home'])('ignores committed and pending tasks outside the participating roster: %s', (scope) => {
    const original = sources();
    const devices = original.getDevices();
    for (const pending of [false, true]) {
      const result = horizonSource(sources({
        getDevices: () => scope === 'other_home' ? devices.filter(device => device.id !== 'ev')
          : devices.map(device => device.id === 'ev' ? { ...device, managed: false } : device),
        getActiveTasks: () => ({ version: 2, plansByDeviceId: { ev: { ...task(0.5), pending } } }),
      })).readHorizon('battery', config);
      if (result.kind !== 'ready') throw new Error('An excluded task must not block battery planning');
      expect(result.horizon.periods[0].otherManagedDemandKWh).toBe(0);
      expect(result.horizon.periods[0].maxChargeKW).toBe(4.5);
    }
  });

  it('waits for a participating smart task that has not settled its plan', () => {
    expect(horizonSource(sources({
      getActiveTasks: () => ({ version: 2, plansByDeviceId: { ev: { ...task(0.5), pending: true } } }),
    })).readHorizon('battery', config)).toEqual({ kind: 'waiting', reason: 'smart_tasks_planning' });
  });

  it('splits a fractional-offset price period at UTC forecast boundaries', () => {
    const result = horizonSource(sources({
      getNowMs: () => NOW + HOUR_MS / 2,
      getPriceTimeline: () => ({
        state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: false,
        lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
        periods: [{ startsAt: new Date(NOW + HOUR_MS / 2).toISOString(), durationMinutes: 60, importPrice: 0.2, level: 'normal' }],
      }),
      getBackgroundKWh: hour => hour === NOW ? 1 : 2,
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods.map(period => period.durationMs)).toEqual([HOUR_MS / 2, HOUR_MS / 2]);
    expect(result.horizon.periods.map(period => period.householdDemandKWh)).toEqual([0.5, 1]);
  });

  it('does not spread a short EV reservation over the rest of the price period', () => {
    const result = horizonSource(sources({
      getActiveTasks: () => ({ version: 2, plansByDeviceId: { ev: task(0.5, NOW + HOUR_MS / 4, NOW + HOUR_MS * 3 / 4) } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods.map(period => period.otherManagedDemandKWh)).toEqual([0, 0.5, 0]);
    expect(result.horizon.periods.map(period => period.maxChargeKW)).toEqual([4.5, 0, 4.5]);
  });

  it('allows spare forecast solar to charge the battery while a physical EV step occupies grid room', () => {
    const result = horizonSource(sources({
      solarScope: {
        mainDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
        allDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
      },
      getSolarForecast: () => ({ forecast: hours => hours.map(hourStartMs => ({ hourStartMs, generationKwh: 4 })) }),
      getPriceTimeline: () => ({
        state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: true,
        lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
        periods: [{ startsAt: new Date(NOW).toISOString(), durationMinutes: 60, importPrice: 0.2, exportPrice: 0.05, level: 'normal' }],
      }),
      getActiveTasks: () => ({ version: 2, plansByDeviceId: { ev: task(0.5) } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods[0].otherManagedDemandKWh).toBe(0.5);
    expect(result.horizon.periods[0].maxChargeKW).toBe(1.5);
  });

  it('plans forecast solar without an export price, valuing its export at 0 and never as a quote', () => {
    const solarHome = (exportPrice?: number) => horizonSource(sources({
      solarScope: {
        mainDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
        allDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
      },
      getSolarForecast: () => ({ forecast: hours => hours.map(hourStartMs => ({
        hourStartMs, generationKwh: hourStartMs === NOW ? 4 : 0,
      })) }),
      getPriceTimeline: () => ({
        state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: exportPrice !== undefined,
        lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
        // The sunny hour comes first; the dark hour after it must not hide its missing quote.
        periods: [0, 1].map(hour => ({
          startsAt: new Date(NOW + hour * HOUR_MS).toISOString(), durationMinutes: 60, importPrice: 0.2, level: 'normal' as const,
          ...(exportPrice === undefined ? {} : { exportPrice }),
        })),
      }),
    })).readHorizon('battery', config);
    const unpriced = solarHome();
    if (unpriced.kind !== 'ready') throw new Error('Expected a plan without an export price');
    expect(unpriced.exportPricing).toBe('unpriced_solar');
    expect(unpriced.horizon.periods.map(period => [period.solarKWh, period.exportPrice])).toEqual([[4, 0], [0, 0]]);
    expect(solarHome(0)).toMatchObject({ kind: 'ready', exportPricing: 'complete' });
  });

  it.each([
    ['background_unavailable', { getBackgroundKWh: () => undefined }],
    ['forecast_unavailable', { solarScope: {
      mainDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
      allDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
    } }],
  ] as const)('waits for %s instead of treating an unavailable read as zero', (reason, overrides) => {
    expect(horizonSource(sources(overrides)).readHorizon('battery', config))
      .toEqual({ kind: 'waiting', reason });
  });

  it('requires a review of battery wear when the source price unit changes', () => {
    expect(horizonSource(sources()).readHorizon('battery', { ...config, priceUnit: 'øre/kWh' }))
      .toEqual({ kind: 'waiting', reason: 'price_unit_changed' });
  });
});
