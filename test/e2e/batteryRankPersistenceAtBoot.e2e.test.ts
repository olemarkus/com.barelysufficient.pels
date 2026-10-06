// SDK-boundary e2e for mode priority ranks at boot. A newly managed device
// gets a persisted rank above a home battery ranked at the bottom. The
// catalog waits for the device layer to tell the batteries apart, so the boot
// must come back to it once they are known: nothing here reloads the catalog
// by hand, and no unrelated settings change arrives to do it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, mockHomeyInstance, setMockDrivers, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_PRIORITIES,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const socket = async (id: string, name: string): Promise<MockDevice> => {
  const device = new MockDevice(id, name, ['onoff', 'measure_power', 'meter_power'], 'socket');
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 500);
  await device.setCapabilityValue('meter_power', 10);
  return device;
};

const battery = async (): Promise<MockDevice> => {
  const device = new MockDevice('home-battery', 'Home Battery', ['measure_battery', 'measure_power'], 'battery');
  await device.setCapabilityValue('measure_battery', 60);
  await device.setCapabilityValue('measure_power', 0);
  return device;
};

describe('mode priority ranks at boot (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('persists a new device\'s rank above the battery at the bottom once the batteries are known', async () => {
    setMockDrivers({
      sockets: new MockDriver('sockets', [await socket('heater', 'Heater'), await socket('charger', 'Charger')]),
      batteries: new MockDriver('batteries', [await battery()]),
    });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('managed_devices', { heater: true, charger: true });
    mockHomeyInstance.settings.set(CAPACITY_PRIORITIES, { Home: { heater: 1, 'home-battery': 2 } });

    const app = createApp();
    await app.onInit();
    const persisted = (): unknown => mockHomeyInstance.settings.get(CAPACITY_PRIORITIES);
    for (let second = 0; second < 60 && (persisted() as { Home: Record<string, number> }).Home.charger === undefined;
      second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await drainUntil(() => (persisted() as { Home: Record<string, number> }).Home.charger !== undefined);

    expect(persisted()).toEqual({ Home: { heater: 1, charger: 2, 'home-battery': 3 } });
  });
});
