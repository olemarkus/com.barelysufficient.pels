// The physical plant and Homey wire are synthetic; planning and execution run unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { drainPending } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
} from '../../lib/utils/settingsKeys';

const PERIOD_START_MS = Date.UTC(2026, 0, 15, 12);
const POLL_MS = 10_000;
const RESPONSE_MS = 180_000;
const REQUESTED_TARGET = 22;
const LIMITED_TARGET = 19;
const targetPath = (id: string) => `manager/devices/device/${id}/capability/target_temperature`;

type PumpEffect = { kind: 'none' } | { kind: 'scheduled'; atMs: number; powerW: number };
type Pump = { device: MockDevice; powerW: number; effect: PumpEffect };
type TargetWrite = { id: string; target: number; atMs: number };
type HeatpumpPlantSettings = { limitKw: number; marginKw: number; backgroundW: number };
const ORDINARY_RESTORE_PLANT: HeatpumpPlantSettings = { limitKw: 10, marginKw: 2, backgroundW: 7500 };
const REPORT_LIKE_PLANT: HeatpumpPlantSettings = { limitKw: 10, marginKw: 0.2, backgroundW: 7700 };

async function buildPump(id: string): Promise<Pump> {
  const device = new MockDevice(id, id, [
    'onoff', 'target_temperature', 'measure_temperature', 'measure_power', 'meter_power', 'thermostat_mode',
  ], 'heatpump');
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('target_temperature', REQUESTED_TARGET);
  await device.setCapabilityValue('measure_temperature', 21);
  await device.setCapabilityValue('measure_power', 1000);
  await device.setCapabilityValue('meter_power', 100);
  await device.setCapabilityValue('thermostat_mode', 'heat');
  device.configureCapabilityBehavior('target_temperature', {
    onApiWrite: { emitCapabilityEvent: true, emitDeviceUpdate: true },
  });
  return { device, powerW: 1000, effect: { kind: 'none' } };
}

async function bootPlant(plantSettings: HeatpumpPlantSettings = ORDINARY_RESTORE_PLANT) {
  const pumps = await Promise.all([buildPump('pump-a'), buildPump('pump-b')]);
  setMockDrivers({ pumps: new MockDriver('pumps', pumps.map(({ device }) => device)) });
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_LIMIT_KW, plantSettings.limitKw);
  settings.set(CAPACITY_MARGIN_KW, plantSettings.marginKw);
  settings.set(CAPACITY_DRY_RUN, false);
  settings.set('controllable_devices', { 'pump-a': true, 'pump-b': true });
  settings.set('managed_devices', { 'pump-a': true, 'pump-b': true });
  settings.set('capacity_priorities', { Home: { 'pump-a': 1, 'pump-b': 2 } });
  settings.set('operating_mode', 'Home');
  settings.set('mode_device_targets', { Home: { 'pump-a': REQUESTED_TARGET, 'pump-b': REQUESTED_TARGET } });
  settings.set('overshoot_behaviors', {
    'pump-a': { action: 'set_temperature', temperature: LIMITED_TARGET },
    'pump-b': { action: 'set_temperature', temperature: LIMITED_TARGET },
  });
  let backgroundW = plantSettings.backgroundW;
  let energyKWh = 0;
  let previousMeter: { atMs: number; powerW: number } | undefined;
  const writes: TargetWrite[] = [];
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path !== 'manager/energy/live') return originalGet(path);
    const now = Date.now();
    for (const pump of pumps) {
      if (pump.effect.kind !== 'scheduled' || pump.effect.atMs > now) continue;
      pump.powerW = pump.effect.powerW;
      pump.effect = { kind: 'none' };
      pump.device.setActualCapabilityValue('measure_power', pump.powerW, {
        updateApi: true, emitCapabilityEvent: true, emitDeviceUpdate: true,
      });
    }
    if (previousMeter !== undefined) {
      const elapsedInPeriodMs = Math.max(0, now - Math.max(previousMeter.atMs, PERIOD_START_MS));
      energyKWh += previousMeter.powerW * elapsedInPeriodMs / 3_600_000_000;
    }
    const powerW = backgroundW + pumps.reduce((sum, pump) => sum + pump.powerW, 0);
    previousMeter = { atMs: now, powerW };
    return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: powerW } }] };
  });
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const result = await originalPut(path, body);
    const pump = pumps.find(({ device }) => path === targetPath(device.idValue));
    if (pump !== undefined) {
      const target = (body as { value: number }).value;
      writes.push({ id: pump.device.idValue, target, atMs: Date.now() });
      // A newer request supersedes an electrical response that has not occurred.
      pump.effect = {
        kind: 'scheduled', atMs: Date.now() + RESPONSE_MS,
        powerW: target === LIMITED_TARGET ? 0 : 1000,
      };
    }
    return result;
  });
  connectLiveFeed();
  const app = createApp();
  await app.onInit();
  const poll = async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await drainPending();
  };
  return {
    pumps, writes, put, poll,
    setBackground: (powerW: number) => { backgroundW = powerW; },
    energyKWh: () => energyKWh,
  };
}

async function pollUntil(plant: Awaited<ReturnType<typeof bootPlant>>, done: () => boolean, maxPolls: number) {
  for (let count = 0; count < maxPolls && !done(); count += 1) await plant.poll();
  expect(done()).toBe(true);
}

describe('slow binary-capable heat-pump control loop through Homey', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [
      'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
      'clearTimeout', 'clearInterval', 'clearImmediate',
    ] });
    vi.setSystemTime(PERIOD_START_MS - POLL_MS);
    resetMockHomey();
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('paces real setpoint restores and does not repeat them for a brief background pulse', async () => {
    const plant = await bootPlant();
    const reductions = () => plant.writes.filter(({ target }) => target === LIMITED_TARGET);
    const restores = () => plant.writes.filter(({ target }) => target === REQUESTED_TARGET);
    // Sustained ordinary capacity pressure must eventually restrict both pumps.
    await pollUntil(plant, () => reductions().length === 2, 18);
    expect(plant.pumps.map(({ powerW }) => powerW)).toEqual([1000, 1000]);
    for (const { device } of plant.pumps) {
      await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(LIMITED_TARGET);
      await expect(device.getCapabilityValue('onoff')).resolves.toBe(true);
    }
    // The background load clears before the delayed physical effect. A target
    // echo has confirmed the setting, but has not turned the compressors off.
    plant.setBackground(1000);
    await pollUntil(plant, () => restores().length > 0, 72);
    expect(restores()).toHaveLength(1);
    const firstRestore = restores()[0];
    await pollUntil(plant, () => restores().length === 2, 72);
    expect(restores()[1].atMs - firstRestore.atMs).toBeGreaterThanOrEqual(300_000);
    await pollUntil(plant, () => plant.pumps.every(({ powerW }) => powerW === 1000), 24);

    // Shape the *configured limit*, not planner state, using the plant's
    // independently integrated physical energy. With a 9 kW operating pace,
    // 8 kW baseline and 9.3 kW pulse, the pulse retains the protected response reserve.
    const hoursLeft = (PERIOD_START_MS + 3_600_000 - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(0.25);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, plant.energyKWh() + 9 * hoursLeft + 1);
    plant.setBackground(6000);
    for (let poll = 0; poll < 4; poll += 1) await plant.poll();
    const writesBeforePulse = plant.writes.length;
    plant.setBackground(7300);
    await plant.poll();
    await plant.poll();
    plant.setBackground(6000);
    for (let poll = 0; poll < 12; poll += 1) await plant.poll();
    expect(plant.writes.slice(writesBeforePulse)).toEqual([]);
    expect(plant.put.mock.calls.filter(([path]) => path.endsWith('/onoff'))).toEqual([]);
  });

  it('keeps a 10 kW / 0.2 kW-margin home steady across two affordable capacity spikes', async () => {
    const plant = await bootPlant(REPORT_LIKE_PLANT);
    // Real polls observe the previous capacity period and cross its boundary;
    // grace must be funded from that observed period, rather than a fresh boot.
    for (let poll = 0; poll < 8; poll += 1) await plant.poll();
    const writesBeforePulses = plant.writes.length;
    for (let pulse = 0; pulse < 2; pulse += 1) {
      // The compressors remain at 2 kW: only the uncontrolled load pulses,
      // moving total import from 9.7 to 9.88 kW for two real ten-second polls.
      // The remaining projection spare covers the protected half-margin and
      // the next poll at the bounded two-compressor relief cost.
      plant.setBackground(7880);
      await plant.poll();
      await plant.poll();
      plant.setBackground(7700);
      for (let poll = 0; poll < 36; poll += 1) await plant.poll();
      expect(plant.writes.slice(writesBeforePulses)).toEqual([]);
      expect(plant.pumps.map(({ powerW }) => powerW)).toEqual([1000, 1000]);
      for (const { device } of plant.pumps) {
        await expect(device.getCapabilityValue('target_temperature')).resolves.toBe(REQUESTED_TARGET);
        await expect(device.getCapabilityValue('onoff')).resolves.toBe(true);
      }
    }
    expect(plant.put.mock.calls.filter(([path]) => path.endsWith('/onoff'))).toEqual([]);
  });

  it('limits promptly when a below-cap projection already occupies the protected margin', async () => {
    const plant = await bootPlant(REPORT_LIKE_PLANT);
    for (let poll = 0; poll < 8; poll += 1) await plant.poll();
    const writesBeforePressure = plant.writes.length;
    // At 9.95 kW the 10 kW actual cap is still clear, but its unchanged-load
    // projection leaves about 50 Wh: less than the protected 100 Wh reserve.
    // PELS cannot spend that already-occupied reserve on another grace period.
    plant.setBackground(7950);
    await pollUntil(plant, () => plant.writes.slice(writesBeforePressure)
      .some(({ target }) => target === LIMITED_TARGET), 2);
    expect(plant.pumps.map(({ powerW }) => powerW)).toEqual([1000, 1000]);
    expect(plant.put.mock.calls.filter(([path]) => path.endsWith('/onoff'))).toEqual([]);
  });
});
