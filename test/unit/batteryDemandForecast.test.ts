import { describe, expect, it, vi } from 'vitest';
import { BatteryDemandForecaster } from '../../lib/battery/batteryDemandForecast';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.UTC(2026, 9, 27, 10);
const HOUR_MS = 3_600_000;
const forecaster = (): BatteryDemandForecaster => new BatteryDemandForecaster(
  () => [], () => 'Europe/Oslo', { mainDevices: () => [], allDevices: () => [] }, () => true,
);

describe('battery-neutral household demand forecast', () => {
  it('skips device and solar reads while no continuous battery plan is enabled', () => {
    const getDevices = vi.fn(() => []);
    const getTimeZone = vi.fn(() => 'Europe/Oslo');
    const solarScope = { mainDevices: vi.fn(() => []), allDevices: vi.fn(() => []) };
    const model = new BatteryDemandForecaster(getDevices, getTimeZone, solarScope, () => false);
    model.recordNetSample(1000, undefined, NOW);
    expect(getDevices).not.toHaveBeenCalled();
    expect(getTimeZone).not.toHaveBeenCalled();
    expect(solarScope.mainDevices).not.toHaveBeenCalled();
    expect(solarScope.allDevices).not.toHaveBeenCalled();
  });

  it('starts learning when planning is enabled and retains accepted history while disabled', () => {
    const battery = partialDouble<DeviceSurfaces>({
      id: 'battery', deviceClass: 'battery', available: true, isBatteryOrSolar: true,
      batteryPower: { signedW: 0, observedAtMs: NOW },
    });
    let enabled = false;
    const getDevices = vi.fn(() => [battery]);
    const getTimeZone = vi.fn(() => 'Europe/Oslo');
    const model = new BatteryDemandForecaster(getDevices, getTimeZone,
      { mainDevices: () => [], allDevices: () => [] }, () => enabled);
    model.recordNetSample(9000, undefined, NOW - HOUR_MS);
    expect(getDevices).not.toHaveBeenCalled();
    enabled = true;
    model.recordNetSample(1000, undefined, NOW);
    expect(model.forecast(NOW)).toBe(1);
    enabled = false;
    getDevices.mockClear();
    getTimeZone.mockClear();
    model.recordNetSample(9000, undefined, NOW + HOUR_MS);
    expect(getDevices).not.toHaveBeenCalled();
    expect(getTimeZone).not.toHaveBeenCalled();
    expect(model.forecast(NOW + HOUR_MS)).toBe(1);
    enabled = true;
    model.recordNetSample(2000, undefined, NOW + HOUR_MS);
    expect(model.forecast(NOW + HOUR_MS)).toBe(2);
  });

  it('ignores foreign aggregate generation without Main panels and skips mixed PV samples', () => {
    const battery = partialDouble<DeviceSurfaces>({
      id: 'battery', deviceClass: 'battery', available: true, isBatteryOrSolar: true,
      batteryPower: { signedW: 0, observedAtMs: NOW },
    });
    const foreign = { id: 'foreign', deviceClass: 'solarpanel' };
    const main = { id: 'main-pv', deviceClass: 'solarpanel' };
    let mainDevices: { id: string; deviceClass: string }[] = [];
    const model = new BatteryDemandForecaster(() => [battery], () => 'Europe/Oslo', {
      mainDevices: () => mainDevices, allDevices: () => [foreign, ...mainDevices],
    }, () => true);
    model.recordNetSample(1000, 5000, NOW);
    expect(model.forecast(NOW)).toBe(1);
    mainDevices = [main];
    model.recordNetSample(1000, 5000, NOW + HOUR_MS);
    expect(model.forecast(NOW + HOUR_MS)).toBe(1);
  });

  it('waits for an observation and forecasts unseen hours from real measured background', () => {
    const model = forecaster();
    expect(model.forecast(NOW)).toBeUndefined();
    model.observe({ atMs: NOW, netImportKW: 4, solarKW: 1, batteryPowerKW: 2, managedPowerKW: 2 });
    expect(model.forecast(NOW)).toBe(1);
    expect(model.forecast(NOW + 12 * HOUR_MS)).toBe(1);
  });

  it('learns the same background while the battery charges or supplies the house', () => {
    const charging = forecaster();
    const supplying = forecaster();
    charging.observe({ atMs: NOW, netImportKW: 5, solarKW: 0, batteryPowerKW: 2, managedPowerKW: 2 });
    supplying.observe({ atMs: NOW, netImportKW: 1, solarKW: 0, batteryPowerKW: -2, managedPowerKW: 2 });
    expect(charging.forecast(NOW)).toBe(1);
    expect(supplying.forecast(NOW)).toBe(1);
  });

  it('retains distinct local-hour observations and ignores duplicate or older meter samples', () => {
    const model = forecaster();
    model.observe({ atMs: NOW, netImportKW: 1, solarKW: 0, batteryPowerKW: 0, managedPowerKW: 0 });
    model.observe({ atMs: NOW, netImportKW: 20, solarKW: 0, batteryPowerKW: 0, managedPowerKW: 0 });
    model.observe({ atMs: NOW - 1, netImportKW: 20, solarKW: 0, batteryPowerKW: 0, managedPowerKW: 0 });
    expect(model.forecast(NOW)).toBe(1);
    model.observe({ atMs: NOW + HOUR_MS, netImportKW: 2, solarKW: 0, batteryPowerKW: 0, managedPowerKW: 0 });
    expect(model.forecast(NOW + 24 * HOUR_MS)).toBe(1);
    expect(model.forecast(NOW + 25 * HOUR_MS)).toBe(2);
  });

  it('retains the accepted model when the meter tap cannot observe a battery', () => {
    const model = forecaster();
    model.observe({ atMs: NOW, netImportKW: 1, solarKW: 0, batteryPowerKW: 0, managedPowerKW: 0 });
    model.recordNetSample(12_000, undefined, NOW + HOUR_MS);
    expect(model.forecast(NOW + HOUR_MS)).toBe(1);
  });
});
