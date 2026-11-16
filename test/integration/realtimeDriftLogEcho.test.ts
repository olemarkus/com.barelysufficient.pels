/**
 * `realtime_capability_drift` is logged for every observed control change,
 * PELS's own writes coming back included. The log says which is which
 * (`pelsEcho`), so a diagnostics reader can tell PELS's limiting from a change
 * made somewhere else. Driven through the live feed's socket, with PELS's real
 * write and Homey's echo of its transaction id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { connectLiveFeed, emitCapability } from '../helpers/liveFeedSocketHarness';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import type { DeviceTransport } from '../../lib/device/deviceTransport';

const DEVICE = 'heater-1';

type AppLike = { deviceManager: DeviceTransport; onInit: () => Promise<void> };

const startApp = async (): Promise<AppLike> => {
  const device = new MockDevice(DEVICE, 'Water heater', ['onoff', 'measure_power'], 'socket');
  device.setSettings({ load: 2000 });
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 2000);
  setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
  mockHomeyInstance.settings.set('capacity_limit_kw', 10);
  mockHomeyInstance.settings.set('capacity_margin_kw', 0);
  mockHomeyInstance.settings.set('capacity_dry_run', false);
  mockHomeyInstance.settings.set('operating_mode', 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  connectLiveFeed();
  const app = createApp({ preserveStartupRestoreStabilization: true }) as unknown as AppLike;
  await app.onInit();
  await vi.advanceTimersByTimeAsync(30_000);
  return app;
};

const driftLogs = (capture: LoggerCapture) => capture.findEvents('realtime_capability_drift')
  .filter((event) => event.deviceId === DEVICE && event.capabilityId === 'onoff');

describe('realtime drift log attribution', () => {
  let capture: LoggerCapture | undefined;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 6, 25, 12, 0, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    capture?.restore();
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks PELS echoes and outside changes apart', async () => {
    const app = await startApp();
    // The app installs its own root logger at init; capture from here on.
    const logs = captureLogger('info');
    capture = logs;
    const write = vi.spyOn(MockDevice.prototype, 'setCapabilityValue').mockResolvedValue(undefined);
    await app.deviceManager.setCapability(DEVICE, 'onoff', false);
    const transactionId = write.mock.calls.at(-1)?.[2];
    expect(transactionId).toMatch(/^pels-/);

    await emitCapability(DEVICE, 'onoff', false, transactionId);
    await emitCapability(DEVICE, 'onoff', true);

    expect(driftLogs(logs).map((event) => [event.pelsEcho, event.changes])).toEqual([
      [true, [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }]],
      [false, [{ capabilityId: 'onoff', previousValue: 'off', nextValue: 'on' }]],
    ]);
  });
});
