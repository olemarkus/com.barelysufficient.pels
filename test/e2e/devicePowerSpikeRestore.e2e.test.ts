import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { connectLiveFeed, emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';

const HEATER_ID = 'heater-1';
const HEATER_ONOFF_PATH = `manager/devices/device/${HEATER_ID}/capability/onoff`;
const MINUTE_MS = 60_000;

type AppLike = {
  onInit: () => Promise<void>;
  latestTargetSnapshot: Array<{ id: string; expectedPowerKw?: number }>;
};

function reportHomePower(getTotalW: () => number): void {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: getTotalW() } }] };
    }
    return originalGet(path);
  });
}

async function reportOffHeaterDraw(heater: MockDevice, measuredW: number): Promise<void> {
  await heater.setCapabilityValue('measure_power', measuredW);
  const lastUpdated = new Date().toISOString();
  emitDeviceUpdate({
    id: HEATER_ID,
    name: 'Water heater',
    class: 'heater',
    capabilities: ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'],
    capabilitiesObj: {
      onoff: { id: 'onoff', value: false, lastUpdated },
      measure_power: { id: 'measure_power', value: measuredW, lastUpdated },
      measure_temperature: { id: 'measure_temperature', value: 50, lastUpdated },
      target_temperature: { id: 'target_temperature', value: 65, units: '°C', lastUpdated },
    },
  });
  await vi.advanceTimersByTimeAsync(1_000);
}

async function runAfterOffReading(offReadingW: number) {
  const heater = new MockDevice(
    HEATER_ID,
    'Water heater',
    ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'],
    'heater',
  );
  await heater.setCapabilityValue('onoff', true);
  await heater.setCapabilityValue('measure_power', 3000);
  await heater.setCapabilityValue('measure_temperature', 50);
  await heater.setCapabilityValue('target_temperature', 65);
  setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });

  const enabled = { [HEATER_ID]: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 9.8);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.2);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set('overshoot_behaviors', { [HEATER_ID]: { action: 'turn_off' } });

  let totalW = 13_000;
  reportHomePower(() => totalW);
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
  const writes = (value: boolean) => putSpy.mock.calls.filter(
    ([path, body]) => path === HEATER_ONOFF_PATH && (body as { value?: unknown })?.value === value,
  ).length;

  connectLiveFeed();
  const app = createApp() as unknown as AppLike;
  await app.onInit();
  await vi.advanceTimersByTimeAsync(MINUTE_MS);
  await drainUntil(() => writes(false) >= 1);
  expect(writes(false)).toBeGreaterThanOrEqual(1);
  await heater.setCapabilityValue('onoff', false);

  await reportOffHeaterDraw(heater, offReadingW);
  await vi.advanceTimersByTimeAsync(30_000);
  await reportOffHeaterDraw(heater, 0);

  totalW = 1_000;
  await vi.advanceTimersByTimeAsync(40 * MINUTE_MS);

  return {
    turnedBackOn: writes(true),
    expectedPowerKw: app.latestTargetSnapshot.find(({ id }) => id === HEATER_ID)?.expectedPowerKw,
  };
}

describe('a single corrupt power reading from a limited water heater', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 10, 8, 16, 5, 0));
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('turns the heater back on after an ordinary off reading', async () => {
    const result = await runAfterOffReading(0);
    expect(result.expectedPowerKw).toBeCloseTo(3, 1);
    expect(result.turnedBackOn).toBeGreaterThanOrEqual(1);
  });

  it('turns the heater back on after a 524.3 kW reading', async () => {
    const result = await runAfterOffReading(524_288);
    expect(result.expectedPowerKw).toBeCloseTo(3, 1);
    expect(result.turnedBackOn).toBeGreaterThanOrEqual(1);
  });
});
