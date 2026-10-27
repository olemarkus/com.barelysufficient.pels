import { describe, expect, it } from 'vitest';
import { createContinuousBatteryPlanSource, type ContinuousBatteryHorizonSources } from '../../lib/planInput/continuousBatteryHorizon';
import type { PlanInputSnapshotDevice } from '../../lib/planInput/runtimeDeviceRead';
import type { BatteryControlOwner, BatteryLeverRead } from '../../lib/ports/batteryControlOwner';
import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import type { DeferredObjectiveActivePlanV1, DeferredObjectiveActivePlanRevisionV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.parse('2026-10-27T00:00:00Z');
const HOUR_MS = 3_600_000;
const config: ContinuousBatteryPlanConfig = {
  enabled: true, usableCapacityKWh: 10, minimumReservePercent: 20,
  roundTripEfficiency: 0.9, wearCostPerKWh: 0.03, priceUnit: 'EUR/kWh',
};
const control: BatteryLeverRead = {
  kind: 'setpoint', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
  deliveryCeilingW: 2500, chargeCeilingW: 2500, claimHeld: false, handBackDeferred: false,
  claimEngaged: false, admissible: true, verdict: 'responding',
};

const sources = (overrides: Partial<ContinuousBatteryHorizonSources> = {}): ContinuousBatteryHorizonSources => ({
  getNowMs: () => NOW,
  getDevices: () => [partialDouble<PlanInputSnapshotDevice>({
    id: 'battery', managed: true, available: true, isBatteryOrSolar: true,
    batteryLevel: { percent: 40, observedAtMs: NOW }, batteryPower: { signedW: 0, observedAtMs: NOW },
  }), partialDouble<PlanInputSnapshotDevice>({ id: 'ev', managed: true, isBatteryOrSolar: false })],
  getControl: () => partialDouble<BatteryControlOwner>({ readControl: () => control }),
  getControllableDevices: () => ({}),
  getPriceTimeline: () => ({
    state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: false,
    lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
    periods: [{ startsAt: new Date(NOW).toISOString(), durationMinutes: 60, importPrice: 0.2, level: 'normal' }],
  }),
  getPowerLimitSettings: () => ({ limitKw: 5, marginKw: 0, periodMinutes: 60, capacityEnabled: true, gridImportLimitKw: null }),
  getActiveTasks: () => ({ version: 1, plansByDeviceId: {} }),
  solarScope: { mainDevices: () => [], allDevices: () => [] },
  getSolarForecast: () => ({ forecast: () => [] }),
  getBackgroundKWh: () => 0.5,
  ...overrides,
});

const task = (plannedKWh: number, startMs = NOW, endMs = NOW + HOUR_MS): DeferredObjectiveActivePlanV1 => (
  partialDouble<DeferredObjectiveActivePlanV1>({
    deviceId: 'ev', deadlineAtMs: endMs, pending: false,
    liveCompletion: { kind: 'unmet', status: 'on_track' },
    latest: partialDouble<DeferredObjectiveActivePlanRevisionV1>({
      hours: [], reservationSegments: [{ startMs, endMs, plannedKWh, plannedAdmissionPowerKw: 7 }],
    }),
  })
);

describe('continuous battery horizon projection', () => {
  it('cannot plan a battery excluded by the main-home membership owner', () => {
    expect(createContinuousBatteryPlanSource(sources({ getDevices: () => [] })).readHorizon('battery', config))
      .toEqual({ kind: 'waiting', reason: 'control_unavailable' });
  });

  it('plans a home without solar from resolved absence, without inventing a solar forecast', () => {
    const result = createContinuousBatteryPlanSource(sources()).readHorizon('battery', config);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods[0].solarKWh).toBe(0);
    expect(result.horizon.periods[0].householdDemandKWh).toBe(0.5);
  });

  it('ignores PV outside Main and waits when an aggregate cannot separate Main and foreign PV', () => {
    const pv = { id: 'pv', deviceClass: 'solarpanel' };
    const foreign = { id: 'foreign-pv', deviceClass: 'solarpanel' };
    const getSolarForecast = () => { throw new Error('A foreign aggregate must not be consumed'); };
    const withoutMain = createContinuousBatteryPlanSource(sources({
      solarScope: { mainDevices: () => [], allDevices: () => [foreign] }, getSolarForecast,
    })).readHorizon('battery', config);
    if (withoutMain.kind !== 'ready') throw new Error('Main has no solar');
    expect(withoutMain.horizon.periods[0].solarKWh).toBe(0);
    expect(createContinuousBatteryPlanSource(sources({
      solarScope: { mainDevices: () => [pv], allDevices: () => [pv, foreign] }, getSolarForecast,
    })).readHorizon('battery', config)).toEqual({ kind: 'waiting', reason: 'solar_scope_shared' });
  });

  it('keeps economic EV energy separate from the physical charging reservation', () => {
    const result = createContinuousBatteryPlanSource(sources({
      getActiveTasks: () => ({ version: 1, plansByDeviceId: { ev: task(0.5) } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods[0].otherManagedDemandKWh).toBe(0.5);
    expect(result.horizon.periods[0].maxChargeKW).toBe(0);
    expect(result.horizon.periods[0].gridImportLimitKW).toBe(5);
  });

  it.each(['unmanaged', 'other_home'])('ignores committed and pending tasks outside the participating roster: %s', (scope) => {
    const original = sources();
    const devices = original.getDevices();
    for (const pending of [false, true]) {
      const result = createContinuousBatteryPlanSource(sources({
        getDevices: () => scope === 'other_home' ? devices.filter(device => device.id !== 'ev')
          : devices.map(device => device.id === 'ev' ? { ...device, managed: false } : device),
        getActiveTasks: () => ({ version: 1, plansByDeviceId: { ev: { ...task(0.5), pending } } }),
      })).readHorizon('battery', config);
      if (result.kind !== 'ready') throw new Error('An excluded task must not block battery planning');
      expect(result.horizon.periods[0].otherManagedDemandKWh).toBe(0);
      expect(result.horizon.periods[0].maxChargeKW).toBe(2.5);
    }
  });

  it('splits a fractional-offset price period at UTC forecast boundaries', () => {
    const result = createContinuousBatteryPlanSource(sources({
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
    const result = createContinuousBatteryPlanSource(sources({
      getActiveTasks: () => ({ version: 1, plansByDeviceId: { ev: task(0.5, NOW + HOUR_MS / 4, NOW + HOUR_MS * 3 / 4) } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods.map(period => period.otherManagedDemandKWh)).toEqual([0, 0.5, 0]);
    expect(result.horizon.periods.map(period => period.maxChargeKW)).toEqual([2.5, 0, 2.5]);
  });

  it('allows spare forecast solar to charge the battery while a physical EV step occupies grid room', () => {
    const result = createContinuousBatteryPlanSource(sources({
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
      getActiveTasks: () => ({ version: 1, plansByDeviceId: { ev: task(0.5) } }),
    })).readHorizon('battery', config);
    if (result.kind !== 'ready') throw new Error('Expected horizon');
    expect(result.horizon.periods[0].otherManagedDemandKWh).toBe(0.5);
    expect(result.horizon.periods[0].maxChargeKW).toBe(1.5);
  });

  it.each([
    ['background_unavailable', { getBackgroundKWh: () => undefined }],
    ['forecast_unavailable', { solarScope: {
      mainDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
      allDevices: () => [{ id: 'pv', deviceClass: 'solarpanel' }],
    } }],
  ] as const)('waits for %s instead of treating an unavailable read as zero', (reason, overrides) => {
    expect(createContinuousBatteryPlanSource(sources(overrides)).readHorizon('battery', config))
      .toEqual({ kind: 'waiting', reason });
  });

  it('requires a review of battery wear when the source price unit changes', () => {
    expect(createContinuousBatteryPlanSource(sources()).readHorizon('battery', { ...config, priceUnit: 'øre/kWh' }))
      .toEqual({ kind: 'waiting', reason: 'price_unit_changed' });
  });
});
