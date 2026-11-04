/**
 * The realtime lifecycle of "Leave off until turned on again", driven end to end
 * through the app: a `device.update` frame arrives on the live feed's socket
 * (`test/helpers/liveFeedSocketHarness.ts`), and the real detector → hold store →
 * persistence → producer path runs unmocked.
 *
 * Integration tier (not e2e) because it reads the hold policy itself
 * (`app.externalOffHold`) beside the persisted keys. The SDK-boundary
 * consequences of an ALREADY-held device (no resume, restart survival) are
 * covered in `test/e2e/externalOffHold.e2e.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { connectLiveFeed, emitDeviceUpdate, emitCapability } from '../helpers/liveFeedSocketHarness';
import {
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';

import type { DeviceTransport } from '../../lib/device/deviceTransport';

const DEVICE = 'heater-1';

type AppLike = {
  deviceManager: DeviceTransport;
  onInit: () => Promise<void>;
  externalOffHold?: { isHeld: (deviceId: string) => boolean };
};

// Stamped when the update is sent: the device changed state just now.
const deviceUpdate = (on: boolean): Record<string, unknown> => {
  const lastUpdated = new Date().toISOString();
  return {
    id: DEVICE,
    name: 'Water heater',
    class: 'socket',
    capabilities: ['onoff', 'measure_power'],
    capabilitiesObj: {
      onoff: { id: 'onoff', value: on, lastUpdated },
      measure_power: { id: 'measure_power', value: on ? 2000 : 0, lastUpdated },
    },
  };
};

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
  connectLiveFeed();
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
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 6, 25, 12, 0, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts and persists a hold when an opted-in device reports off outside PELS', async () => {
    const app = await startApp(true);
    emitDeviceUpdate(deviceUpdate(false));
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);
    expect(heldDeviceIds()).toEqual([DEVICE]);
  });

  it('observes a delayed PELS OFF echo without creating an outside-off hold', async () => {
    const app = await startApp(true);
    // Leave the observed switch ON until Homey's echo arrives. No executor
    // pending record can attribute the late change on the detector's behalf.
    const write = vi.spyOn(MockDevice.prototype, 'setCapabilityValue').mockResolvedValue(undefined);
    await app.deviceManager.setCapability(DEVICE, 'onoff', false);
    const transactionId = write.mock.calls.at(-1)?.[2];
    expect(transactionId).toMatch(/^pels-/);
    vi.setSystemTime(Date.now() + 120_000);
    await emitCapability(DEVICE, 'onoff', false, transactionId);

    expect(app.deviceManager.getSnapshotByDeviceId(DEVICE)?.binaryControl?.on).toBe(false);
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
    expect(heldDeviceIds()).toEqual([]);

    // A separate OFF still has its normal meaning after that echo.
    await emitCapability(DEVICE, 'onoff', true);
    await emitCapability(DEVICE, 'onoff', false);
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);

    await app.deviceManager.setCapability(DEVICE, 'onoff', true);
    await emitCapability(DEVICE, 'onoff', true, write.mock.calls.at(-1)?.[2]);
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
  });

  it('starts no hold for a device that has not opted in', async () => {
    const app = await startApp(false);
    emitDeviceUpdate(deviceUpdate(false));
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
    expect(heldDeviceIds()).toEqual([]);
  });

  it('releases the hold when the device reports on again', async () => {
    const app = await startApp(true);
    emitDeviceUpdate(deviceUpdate(false));
    await settle();
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);

    emitDeviceUpdate(deviceUpdate(true));
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
    expect(heldDeviceIds()).toEqual([]);
  });

  it('releases a held device when its opt-in is switched off', async () => {
    const app = await startApp(true);
    emitDeviceUpdate(deviceUpdate(false));
    await settle();
    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(true);

    mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, {});
    await settle();

    expect(app.externalOffHold?.isHeld(DEVICE)).toBe(false);
  });
});
