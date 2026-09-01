/**
 * The realtime lifecycle of "Leave off until turned on again", driven end to end
 * through the app: a `device.update` arrives at the transport's inbound edge, and
 * the real detector → hold store → persistence → producer path runs unmocked.
 *
 * Integration tier (not e2e) because realtime observations cannot enter through
 * the e2e SDK boundary: the live feed is stubbed off in `test/setup.ts`, so
 * `injectDeviceUpdateForTest` — the transport's documented inbound seam, the
 * exact call the live feed makes — is the closest available equivalent. The
 * SDK-boundary consequences of an ALREADY-held device (no resume, restart
 * survival) are covered in `test/e2e/externalOffHold.e2e.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';

const DEVICE = 'heater-1';

type AppLike = {
  onInit: () => Promise<void>;
  deviceManager?: { injectDeviceUpdateForTest: (device: Record<string, unknown>) => void };
  externalOffHold?: { isHeld: (deviceId: string) => boolean };
};

const deviceUpdate = (on: boolean): Record<string, unknown> => ({
  id: DEVICE,
  name: 'Water heater',
  class: 'socket',
  capabilities: ['onoff', 'measure_power'],
  capabilitiesObj: {
    onoff: { id: 'onoff', value: on },
    measure_power: { id: 'measure_power', value: on ? 2000 : 0 },
  },
});

const seedSettings = (optedIn: boolean) => {
  mockHomeyInstance.settings.set('capacity_limit_kw', 10);
  mockHomeyInstance.settings.set('capacity_margin_kw', 0);
  mockHomeyInstance.settings.set('capacity_dry_run', false);
  mockHomeyInstance.settings.set('operating_mode', 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  if (optedIn) mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, { [DEVICE]: true });
};

const startApp = async (optedIn: boolean): Promise<AppLike> => {
  const device = new MockDevice(DEVICE, 'Water heater', ['onoff', 'measure_power'], 'socket');
  device.setSettings({ load: 2000 });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
  seedSettings(optedIn);
  const app = createApp({ preserveStartupRestoreStabilization: true }) as unknown as AppLike;
  await app.onInit();
  await vi.advanceTimersByTimeAsync(30_000);
  return app;
};

/** Let the reconcile debounce + the rebuild it schedules settle. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(2_000);
};

/**
 * The held devices as the SETTINGS STORE sees them, independently of the policy
 * — the point of these cases is that the hold reached persistence, not merely
 * that the in-process object agrees with itself. A hold is one key whose
 * presence is the fact, so this is a prefix scan of the key list.
 */
const heldDeviceIds = (): string[] => mockHomeyInstance.settings.getKeys()
  .filter((key) => key.startsWith(PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX))
  .map((key) => key.slice(PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX.length));

describe('external-off hold — realtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 6, 25, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts and persists a hold when an opted-in device reports off outside PELS', async () => {
    const app = await startApp(true);
    app.deviceManager?.injectDeviceUpdateForTest(deviceUpdate(false));
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);
    expect(heldDeviceIds()).toEqual([DEVICE]);
  });

  it('starts no hold for a device that has not opted in', async () => {
    const app = await startApp(false);
    app.deviceManager?.injectDeviceUpdateForTest(deviceUpdate(false));
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
    expect(heldDeviceIds()).toEqual([]);
  });

  it('releases the hold when the device reports on again', async () => {
    const app = await startApp(true);
    app.deviceManager?.injectDeviceUpdateForTest(deviceUpdate(false));
    await settle();
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);

    app.deviceManager?.injectDeviceUpdateForTest(deviceUpdate(true));
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
    expect(heldDeviceIds()).toEqual([]);
  });

  it('releases a held device when its opt-in is switched off', async () => {
    const app = await startApp(true);
    app.deviceManager?.injectDeviceUpdateForTest(deviceUpdate(false));
    await settle();
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);

    mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, {});
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
  });
});
