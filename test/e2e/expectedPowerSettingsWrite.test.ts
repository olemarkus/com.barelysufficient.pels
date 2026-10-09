import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../lib/utils/settingsKeys';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import api from '../../api';

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
    // No positive `measure_power` reading (a satisfied water heater reads 0 W,
    // which teaches no peak) and no `settings.load`, so every rung below the
    // manual one is empty and the ladder lands on its 1 kW default. That is the
    // reported bug's shape: a figure PELS invented, which the owner corrects.
    const device = new MockDevice('dev-1', 'Water Heater', ['onoff']);
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 0);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('managed_devices', { 'dev-1': true });

    const app = createApp();
    await app.onInit();
    expect(readExpectedPowerKw(app, 'dev-1')).toBeCloseTo(1);
    return app;
  };

  beforeEach(() => {
    resetMockHomey();
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

  it('clears an unset manual figure and persists the same Flow value again', async () => {
    const app = await startApp();
    const runAction = mockHomeyInstance.flow._actionCardListeners.set_expected_power_usage;
    const args = { device: { id: 'dev-1' }, power_w: 1337 };

    await expect(runAction(args)).resolves.toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES)).toMatchObject({
      'dev-1': { kw: 1.337 },
    });
    await vi.waitFor(async () => {
      const payload = await api.ui_devices({ homey: app.homey });
      expect(payload.devices.find((device) => device.id === 'dev-1')).toMatchObject({
        expectedPowerKw: 1.337,
        expectedPowerSource: 'manual',
      });
    });

    // Native SDK unset removes the key and emits `unset`, not `set` with {}.
    mockHomeyInstance.settings.unset(DEVICE_EXPECTED_POWER_OVERRIDES);
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(DEVICE_EXPECTED_POWER_OVERRIDES);
    await vi.waitFor(async () => {
      const payload = await api.ui_devices({ homey: app.homey });
      const device = payload.devices.find((entry) => entry.id === 'dev-1');
      expect(device?.expectedPowerKw).toBeCloseTo(1);
      expect(device?.expectedPowerSource).not.toBe('manual');
    });

    // A stale live override would make the equality gate accept this as a no-op,
    // leaving settings absent even though the Flow reports success.
    await expect(runAction(args)).resolves.toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_EXPECTED_POWER_OVERRIDES)).toMatchObject({
      'dev-1': { kw: 1.337 },
    });
    await vi.waitFor(async () => {
      const payload = await api.ui_devices({ homey: app.homey });
      expect(payload.devices.find((device) => device.id === 'dev-1')).toMatchObject({
        expectedPowerKw: 1.337,
        expectedPowerSource: 'manual',
      });
    });
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
