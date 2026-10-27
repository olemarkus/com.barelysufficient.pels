import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { INVERTER_CURTAILMENT_DEVICES } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import { INVERTER_CLAIM_PREFIX } from '../../lib/executor/inverterClaimStore';

const NOW = Date.UTC(2026, 5, 19, 12);
const CAP_PATH = 'manager/devices/device/pv/capability/target_power';

describe('native inverter curtailment through the Homey SDK', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
    vi.setSystemTime(NOW);
    resetMockHomey();
  });
  afterEach(async () => { await cleanupApps(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function createSolar(mode: 'direct' | 'switchable' = 'direct'): MockDevice {
    const solar = new MockDevice('pv', 'Roof inverter', ['measure_power', 'meter_power', 'target_power',
      ...(mode === 'switchable' ? ['target_power_mode'] : [])], 'solarpanel');
    solar.setCapabilityMetadata('target_power', { min: 0, max: 6000, step: 1, setable: true });
    return solar;
  }

  async function boot(exportPrice: number, enabled = true, simulation = false, tank?: MockDevice, solar = createSolar()) {
    await solar.setCapabilityValue('measure_power', 5000);
    await solar.setCapabilityValue('meter_power', 42);
    if (await solar.getCapabilityValue('target_power') === undefined) await solar.setCapabilityValue('target_power', 6000);
    setMockDrivers({ solar: new MockDriver('solar', tank ? [solar, tank] : [solar]) });
    const settings = mockHomeyInstance.settings;
    settings.set('power_source', 'homey_energy');
    settings.set('homey_energy_meter_device_id', 'meter-main');
    settings.set('capacity_limit_kw', 10);
    settings.set('capacity_dry_run', simulation);
    settings.set('price_scheme', 'homey');
    settings.set('export_price_enabled', true);
    settings.set('export_price_source', 'manual');
    settings.set('export_spot_factor', 0);
    settings.set('export_fixed', exportPrice);
    settings.set(INVERTER_CURTAILMENT_DEVICES, { pv: enabled });
    if (tank) {
      settings.set('operating_mode', 'Home');
      settings.set('managed_devices', { tank: true });
      settings.set('controllable_devices', { tank: true });
      settings.set('mode_device_targets', { Home: { tank: 20 } });
      settings.set('price_optimization_settings', { tank: {
        enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: 2,
      } });
    }
    mockHomeyInstance.api._dynamicElectricityPrices = async () => ({
      interval: 15, priceUnit: 'EUR', pricesPerInterval: Array.from({ length: 96 }, (_, i) => ({
        periodStart: new Date(Date.UTC(2026, 5, 19) + i * 900_000).toISOString(),
        periodEnd: new Date(Date.UTC(2026, 5, 19) + (i + 1) * 900_000).toISOString(),
        value: -0.1,
      })),
    });
    let gridW = -3000;
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') return {
        items: [{ type: 'cumulative', id: 'meter-main', values: { W: gridW } },
          { type: 'solarpanel', id: 'pv', values: { W: 5000 } }],
      };
      return originalGet(path);
    });
    const puts = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    return { puts, solar, app, grid: (watts: number) => { gridW = watts; } };
  }

  it('caps only excess output and returns the original limit when the export price turns positive', async () => {
    const h = await boot(-0.05);
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: 2050 });
    expect(mockHomeyInstance.settings.get(`${INVERTER_CLAIM_PREFIX}pv`))
      .toMatchObject({ previousLimitW: 6000, previousMode: { kind: 'direct' } });
    // The inverter separately reports its physical output. A target write did
    // not manufacture this reading or alter the meter's reported power.
    await h.solar.setCapabilityValue('measure_power', 2050);
    h.grid(-50);
    mockHomeyInstance.settings.set('export_fixed', 0.08);
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: 6000 });
  });

  it('leaves production alone for positive export value even when import prices are negative', async () => {
    const h = await boot(0.08);
    expect(h.puts.mock.calls.filter(([path]) => path === CAP_PATH)).toEqual([]);
  });

  it('requires explicit opt-in and respects Simulation mode', async () => {
    const h = await boot(-0.05, false);
    expect(h.puts.mock.calls.filter(([path]) => path === CAP_PATH)).toEqual([]);
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    mockHomeyInstance.settings.set(INVERTER_CURTAILMENT_DEVICES, { pv: true });
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    expect(h.puts.mock.calls.filter(([path]) => path === CAP_PATH)).toEqual([]);
  });

  it('lets an existing solar-surplus load settle and receive its boost before curtailing the remainder', async () => {
    const tank = new MockDevice('tank', 'Water tank', [
      'onoff', 'measure_power', 'meter_power', 'measure_temperature', 'target_temperature', 'thermostat_mode',
    ], 'heater');
    for (const [capability, value] of [
      ['onoff', true], ['measure_power', 2000], ['meter_power', 100],
      ['measure_temperature', 19], ['target_temperature', 20], ['thermostat_mode', 'heat'],
    ] as const) await tank.setCapabilityValue(capability, value);
    const h = await boot(-0.05, true, false, tank);
    const boostIndex = h.puts.mock.calls.findIndex(([path, body]) => (
      path === 'manager/devices/device/tank/capability/target_temperature'
      && typeof body === 'object' && body !== null && 'value' in body && body.value === 22
    ));
    const curtailIndex = h.puts.mock.calls.findIndex(([path]) => path === CAP_PATH);
    expect(boostIndex).toBeGreaterThanOrEqual(0);
    expect(curtailIndex).toBeGreaterThan(boostIndex);
  });

  it('hands an already limited inverter back when Simulation mode is enabled', async () => {
    const h = await boot(-0.05);
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: 2050 });
    mockHomeyInstance.settings.set('capacity_dry_run', true);
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: 6000 });
  });
  it('hands an unavailable inverter back instead of dropping its held claim from the plan', async () => {
    const h = await boot(-0.05);
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: 2050 });
    h.puts.mockClear();
    h.solar.setAvailable(false);
    await h.app.refreshTargetDevicesSnapshot();
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: 6000 });
  });

  it.each([
    ['larger range', 6000], ['smaller range', 6000], ['mode options', 6000],
    ['larger range', 0], ['smaller range', 0], ['mode options', 0],
  ] as const)('restores production after native %s changes with dormant cap %i', async (change, dormantW) => {
    const solar = createSolar('switchable');
    await solar.setCapabilityValue('target_power', dormantW);
    await solar.setCapabilityValue('target_power_mode', 'device');
    solar.setCapabilityMetadata('target_power_mode', { setable: true, values: [{ id: 'device' }, { id: 'homey' }] });
    const h = await boot(-0.05, true, false, undefined, solar);
    const modePath = 'manager/devices/device/pv/capability/target_power_mode';
    expect(h.puts).toHaveBeenCalledWith(modePath, { value: 'homey' });
    h.puts.mockClear();
    if (change !== 'mode options') solar.setCapabilityMetadata('target_power', {
      min: 0, max: change === 'smaller range' ? 5000 : 7000, step: 1, setable: true,
    });
    else solar.setCapabilityMetadata('target_power_mode', { setable: true, values: [{ id: 'device' }, { id: 'homey' }, { id: 'eco' }] });
    await h.app.refreshTargetDevicesSnapshot();
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    await drainPending();
    expect(h.puts).toHaveBeenCalledWith(CAP_PATH, { value: change === 'smaller range' ? 5000 : 6000 });
    expect(h.puts.mock.calls.filter(([path]) => path === modePath)).toEqual([]);
  });

});
