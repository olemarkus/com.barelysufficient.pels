import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../lib/utils/settingsKeys';
import { createApp, cleanupApps } from '../utils/appTestUtils';

/**
 * The settings-UI "Power when running" field writes the same persisted record
 * the `set_expected_power_usage` Flow card writes — but through the settings
 * key, not through the app object. The runtime resolves expected power from an
 * IN-MEMORY map that used to be read only at boot, so these drive the real
 * `settings.set` seam and assert the resolved figure on the live snapshot: what
 * the owner typed has to take effect on a running app, not on the next restart.
 */
describe('Expected power written through the settings key', () => {
  const readExpectedPowerKw = (app: unknown, deviceId: string): number | undefined => {
    const snapshot = (app as { latestTargetSnapshot: Array<{ id: string; expectedPowerKw?: number }> })
      .latestTargetSnapshot;
    return snapshot.find((device) => device.id === deviceId)?.expectedPowerKw;
  };

  const startApp = async () => {
    // No `measure_power` reading and no `settings.load`, so every rung below the
    // manual one is empty and the ladder lands on its 1 kW default. That is the
    // reported bug's shape: a figure PELS invented, which the owner corrects.
    const device = new MockDevice('dev-1', 'Water Heater', ['onoff']);
    await device.setCapabilityValue('onoff', true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();
    expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(1);
    return app;
  };

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('resolves the new figure without a restart', async () => {
    const app = await startApp();

    mockHomeyInstance.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, {
      'dev-1': { kw: 2.4, ts: Date.now() },
    });

    await vi.waitFor(() => expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(2.4));
    expect(app.expectedPowerKwOverrides['dev-1']?.kw).toBeCloseTo(2.4);
  });

  it('returns to the automatic figure when the entry is cleared', async () => {
    const app = await startApp();

    mockHomeyInstance.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, {
      'dev-1': { kw: 2.4, ts: Date.now() },
    });
    await vi.waitFor(() => expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(2.4));

    // An EMPTY record is what clearing the last figure persists as. The boot
    // loader used to treat an empty parse as a bad read and keep what it held,
    // which would have made this clear invisible to the running app.
    mockHomeyInstance.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, {});

    await vi.waitFor(() => expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(1));
    expect(app.expectedPowerKwOverrides['dev-1']).toBeUndefined();
  });

  it('keeps the live figure when the record reads back malformed', async () => {
    const app = await startApp();

    mockHomeyInstance.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, {
      'dev-1': { kw: 2.4, ts: Date.now() },
    });
    await vi.waitFor(() => expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(2.4));

    // Not an empty answer — an unreadable one. The owner's figure survives, and
    // nothing is written back over the persisted record.
    mockHomeyInstance.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, 'not-a-record');

    await vi.waitFor(() => expect(
      mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES),
    ).toBe('not-a-record'));
    expect(app.expectedPowerKwOverrides['dev-1']?.kw).toBeCloseTo(2.4);
    expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(2.4);
  });
});
