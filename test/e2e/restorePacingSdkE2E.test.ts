import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';
import { connectLiveFeed, emitCapability } from '../helpers/liveFeedSocketHarness';

async function buildHeater(id: string, load = 3200): Promise<MockDevice> {
  const device = new MockDevice(id, id, ['onoff', 'measure_power'], 'heater');
  device.setSettings({ load });
  await device.setCapabilityValue('onoff', false);
  await device.setCapabilityValue('measure_power', 0);
  return device;
}

async function startPacing(limitKw: number, initialHomePowerW: number) {
  let homePowerW = initialHomePowerW;
  const enabled = { first: true, second: true };
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, enabled);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, enabled);
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { first: 1, second: 2 } });
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: homePowerW } }] };
    }
    return originalGet(path);
  });
  const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
  const firstPath = 'manager/devices/device/first/capability/onoff';
  const secondPath = 'manager/devices/device/second/capability/onoff';
  const app = createApp();
  await app.onInit();
  await drainUntilCalledWith(putSpy, firstPath, { value: true });
  return { putSpy, secondPath, setHomePower: (watts: number) => { homePowerW = watts; } };
}

describe('restore pacing at the SDK boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
      ],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 5, 10));
    resetMockHomey();
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('holds the next device past the recorded 250-second startup tail, even with fresh low meter readings', async () => {
    const first = await buildHeater('first');
    const second = await buildHeater('second');
    setMockDrivers({ driverA: new MockDriver('driverA', [first, second]) });
    const { putSpy, secondPath } = await startPacing(5.1, 900);
    expect(putSpy).not.toHaveBeenCalledWith(secondPath, { value: true });

    // Confirmation of ON is immediate; drawing power is deliberately delayed.
    // Both devices fit individually, but not in one same-cycle restore batch.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(putSpy).not.toHaveBeenCalledWith(secondPath, { value: true });
    await vi.advanceTimersByTimeAsync(189_000);
    expect(putSpy).not.toHaveBeenCalledWith(secondPath, { value: true });

    // A device that never draws must not hold the queue forever either.
    await vi.advanceTimersByTimeAsync(60_000);
    await drainUntilCalledWith(putSpy, secondPath, { value: true });
  });

  it.each(['poll', 'realtime'])('restores early after %s device draw and a later home reading', async (source) => {
    if (source === 'realtime') connectLiveFeed();
    const first = await buildHeater('first', 1500);
    const second = await buildHeater('second', 1500);
    setMockDrivers({ driverA: new MockDriver('driverA', [first, second]) });
    const { putSpy, secondPath, setHomePower } = await startPacing(4, 500);
    expect(putSpy).not.toHaveBeenCalledWith(secondPath, { value: true });

    // The first command has confirmed; the next meter poll has not arrived.
    await vi.advanceTimersByTimeAsync(1000);
    await first.setCapabilityValue('measure_power', 1500);
    if (source === 'realtime') await emitCapability('first', 'measure_power', 1500);
    await drainPending();
    expect(putSpy).not.toHaveBeenCalledWith(secondPath, { value: true });

    // The later home reading includes the first heater and still leaves room.
    setHomePower(2000);
    await vi.advanceTimersByTimeAsync(90_000);
    await drainUntilCalledWith(putSpy, secondPath, { value: true });
  });
});
