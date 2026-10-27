import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import { getSettingsUiDeviceLogPayload } from '../../setup/settingsUiApi';
import { DEVICE_ACTIVITY_SETTLE_MS } from '../../lib/diagnostics/deviceActivityRecorder';

describe('device activity history through app startup and SDK observations', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    resetMockHomey();
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serves recorded device states and their reasons after a new app boots on the same SQLite file', async () => {
    const device = new MockDevice('heater', 'Hall heater', ['onoff', 'measure_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 2000);
    setMockDrivers({ sockets: new MockDriver('sockets', [device]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    mockHomeyInstance.settings.set('controllable_devices', { heater: true });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 5000 } }] }
        : originalGet(path)
    ));

    const first = createApp({ withoutPowerMeasurement: true });
    await first.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    const saved = getSettingsUiDeviceLogPayload(first);
    expect(saved.entries.length).toBeGreaterThan(0);
    expect(saved.entries).toContainEqual(expect.objectContaining({ deviceId: 'heater', deviceName: 'Hall heater' }));
    expect(saved.entries.some((entry) => entry.statusMsg.length > 0)).toBe(true);
    await first.onUninit();

    vi.setSystemTime(Date.now() + 60_000);
    const second = createApp({ withoutPowerMeasurement: true });
    await second.onInit();
    // The new boot's own rows are stored once they settle.
    await vi.advanceTimersByTimeAsync(DEVICE_ACTIVITY_SETTLE_MS);
    const restored = getSettingsUiDeviceLogPayload(second);
    for (const previous of saved.entries) expect(restored.entries).toContainEqual(previous);
    expect(restored.persistence).toBe('stored');
  });
});
