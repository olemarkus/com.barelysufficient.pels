import { describe, expect, it } from 'vitest';
import { BatteryDemandForecaster } from '../../lib/battery/batteryDemandForecast';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { partialDouble } from '../helpers/partialDouble';

const NOW = Date.UTC(2026, 9, 27, 10);
const HOUR_MS = 3_600_000;
const forecaster = (): BatteryDemandForecaster => new BatteryDemandForecaster(
  () => [], () => 'Europe/Oslo', { mainDevices: () => [], allDevices: () => [] },
);

describe('battery-neutral household demand forecast', () => {
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
    });
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
