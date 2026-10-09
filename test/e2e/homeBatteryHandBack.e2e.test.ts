// SDK-boundary e2e for home-battery hand-back. Nothing internal is mocked: a
// claim record a previous run left enters as a persisted Homey setting, the
// battery enters through the real device API, the opt-out as the owner's
// settings write, and what is asserted is what PELS writes back through the
// SDK (`api.put`), the settings it leaves, and its structured logs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import { buildSetpointBatteryDevice } from '../helpers/homeBatteryMock';
import {
  BATTERY_CONTROL_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  OPERATING_MODE_SETTING,
  PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX,
} from '../../lib/utils/settingsKeys';

const BATTERY = 'home-battery';
const CLAIM_KEY = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}${BATTERY}`;

type LoggedEvent = { event?: string; deviceId?: string; reason?: string; failure?: string };

const batteryWrites = (put: { mock: { calls: unknown[][] } }): Array<[string, unknown]> => put.mock.calls
  .filter(([path]) => typeof path === 'string' && path.startsWith(`manager/devices/device/${BATTERY}/capability/`))
  .map(([path, body]) => [
    (path as string).slice(`manager/devices/device/${BATTERY}/capability/`.length),
    (body as { value?: unknown } | undefined)?.value,
  ]);

/** Advance the clock a second at a time until `predicate` holds; boot runs its bootstrap refresh on timers. */
const advanceUntil = async (predicate: () => boolean, seconds = 60): Promise<void> => {
  for (let second = 0; second < seconds && !predicate(); second += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await drainUntil(predicate);
};

const seedSettings = (): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  // What a run that crashed while holding the battery leaves behind.
  mockHomeyInstance.settings.set(CLAIM_KEY, {
    capabilityId: 'target_power_mode',
    previousValue: 'anti_feed',
    claimedAtMs: Date.now() - 3_600_000,
  });
};

const startApp = async (): Promise<{ put: ReturnType<typeof vi.spyOn>; events: LoggedEvent[] }> => {
  const put = vi.spyOn(mockHomeyInstance.api, 'put');
  const app = createApp();
  const events: LoggedEvent[] = [];
  const log = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        const parsed = JSON.parse(arg) as LoggedEvent;
        if (parsed.event?.startsWith('battery_control_')) events.push(parsed);
      } catch { /* not a structured line */ }
    }
    return log(...args);
  };
  await app.onInit();
  return { put, events };
};

describe('home battery hand-back (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 0, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hands back a battery a crashed run left claimed: setpoint 0, then the claim value it held before', async () => {
    const battery = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'homey', targetPowerW: -2000 });
    setMockDrivers({ batteries: new MockDriver('batteries', [battery]) });
    seedSettings();

    const { put, events } = await startApp();
    await advanceUntil(() => mockHomeyInstance.settings.get(CLAIM_KEY) === null);

    expect(batteryWrites(put)).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(battery.getActualCapabilityValue('target_power_mode')).toBe('anti_feed');
    expect(events.find((event) => event.event === 'battery_control_released'))
      .toMatchObject({ deviceId: BATTERY, reason: 'boot_recovery' });
  });

  it('hands back a claimed battery the owner opts out of control', async () => {
    const battery = buildSetpointBatteryDevice({ id: BATTERY, claimValue: 'homey', targetPowerW: -2000 });
    // The boot hand-back fails: the battery refuses the zero setpoint.
    battery.configureCapabilityBehavior('target_power', { onApiWrite: { accept: false } });
    setMockDrivers({ batteries: new MockDriver('batteries', [battery]) });
    seedSettings();

    const { put, events } = await startApp();
    await advanceUntil(() => events.some((event) => event.event === 'battery_control_release_failed'));
    expect(mockHomeyInstance.settings.get(CLAIM_KEY)).not.toBeNull();

    // The battery answers again, and the owner turns PELS's control of it off.
    battery.clearCapabilityBehavior('target_power');
    mockHomeyInstance.settings.set(BATTERY_CONTROL_DEVICES, { [BATTERY]: false });
    await drainUntil(() => mockHomeyInstance.settings.get(CLAIM_KEY) === null);

    expect(batteryWrites(put).slice(-2)).toEqual([['target_power', 0], ['target_power_mode', 'anti_feed']]);
    expect(events.find((event) => event.event === 'battery_control_released'))
      .toMatchObject({ deviceId: BATTERY, reason: 'opted_out' });
  });
});
