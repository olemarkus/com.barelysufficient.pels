// SDK-boundary e2e for "Leave off until turned on again": once a hold exists,
// PELS must not turn the device back on — including across a restart, and
// including the capacity-control-off force-ON lane. The one exception is a smart
// task: an hour it books ends the hold (owner ruling, 2026-10-06).
//
// Nothing internal is mocked. The hold and the opt-in enter as persisted Homey
// settings (exactly the state a previous session would have left behind), the
// device's off state enters through the real device API, whole-home power
// through the real Homey Energy poll, and the only thing asserted is what PELS
// writes back through the SDK (`api.put` of `onoff`).
//
// Scope note: the DETECTION half of the feature is push-driven and cannot be
// exercised here — the live feed is stubbed off in `test/setup.ts`, so no
// realtime observation can enter through the SDK boundary. It is covered
// end-to-end through the app in test/integration/externalOffHoldRealtime.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  COMBINED_PRICES,
  EXTERNAL_OFF_HOLDS,
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
  OPERATING_MODE_SETTING,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import { drainPending, drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const DEVICE = 'water-heater';
const LOAD_W = 2000;
const HOLD_AT_MS = Date.UTC(2026, 6, 25, 11, 0, 0);
const NOW_MS = Date.UTC(2026, 6, 25, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

const buildHeater = async () => {
  const device = new MockDevice(DEVICE, 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
  device.setSettings({ load: LOAD_W });
  await device.setCapabilityValue('onoff', false);
  await device.setCapabilityValue('measure_power', 0);
  await device.setCapabilityValue('meter_power', 100);
  return device;
};

// Whole-home power fed through the real Homey Energy poll. Zero import means
// there is ample available power, so the restore lane would normally resume an
// off managed device — which is exactly what the hold has to prevent.
const wireHomePower = () => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 0 } }] };
    }
    return originalGet(path);
  });
};

const seedSettings = (params: { optedIn: boolean; held: boolean; controllable?: boolean }) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: params.controllable ?? true });
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE]: true });
  if (params.optedIn) mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, { [DEVICE]: true });
  if (params.held) {
    // Deliberately seeded in the LEGACY blob shape rather than as a per-device
    // key. Holds now live one-key-per-device, and the blob→per-key migration
    // runs at boot — so seeding the old shape makes every case below double as
    // end-to-end migration coverage: an upgrading owner's hold has to survive
    // the first boot on the new build, driven through the real SDK boundary
    // rather than by calling the migration directly.
    mockHomeyInstance.settings.set(EXTERNAL_OFF_HOLDS, {
      version: 1,
      entriesByDeviceId: {
        [DEVICE]: { sinceMs: HOLD_AT_MS, observedAtMs: HOLD_AT_MS, capabilityId: 'onoff' },
      },
    });
  }
};

const advancePolls = async (count: number) => {
  for (let i = 0; i < count; i += 1) {
    await vi.advanceTimersByTimeAsync(10_000);
  }
};

const onoffPuts = (putSpy: { mock: { calls: unknown[][] } }) => putSpy.mock.calls
  .filter(([path]) => path === cap(DEVICE, 'onoff'))
  .map(([, body]) => (body as { value?: boolean } | undefined)?.value);

describe('Leave off until turned on again (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' and 'performance' MUST be faked: the plan-rebuild scheduler reads
    // the monotonic clock and the rest of the app reads Date. Either left real
    // runs on real time against the fake timers and strands the rebuild.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(NOW_MS);
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const startApp = async () => {
    wireHomePower();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp({ preserveStartupRestoreStabilization: true });
    await app.onInit();
    return putSpy;
  };

  it('never resumes a device whose hold survived the restart', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });

    const putSpy = await startApp();
    // Well past the 60–300 s restore cooldowns, with ample available power.
    await advancePolls(60);
    await drainPending();

    expect(onoffPuts(putSpy)).not.toContain(true);
  });

  it('resumes the same device when no hold is persisted (the behaviour that changed)', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: false });

    const putSpy = await startApp();
    await advancePolls(60);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });

    expect(onoffPuts(putSpy)).toContain(true);
  });

  it('releases the device when the opt-in is switched off while it is held', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });

    const putSpy = await startApp();
    await advancePolls(6);
    expect(onoffPuts(putSpy)).not.toContain(true);

    // The user turns "Leave off until turned on again" off in Settings.
    mockHomeyInstance.settings.set(RESPECT_EXTERNAL_OFF_DEVICES, {});
    await advancePolls(60);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });

    expect(onoffPuts(putSpy)).toContain(true);
    // The hold key is gone, and the migration consumed the legacy blob on boot.
    expect(mockHomeyInstance.settings.getKeys())
      .not.toContain(`${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${DEVICE}`);
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(EXTERNAL_OFF_HOLDS);
  });

  it('does not force a held device on when Power-limit control is turned off', async () => {
    // The device is held from boot, so PELS never shed it and the
    // capacity-control-off lane has nothing of PELS's to undo. The lane's own
    // hold guard is pinned in `externalOffHoldPlan.test.ts`.
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });

    const putSpy = await startApp();
    await advancePolls(6);

    mockHomeyInstance.settings.set('controllable_devices', { [DEVICE]: false });
    await advancePolls(30);
    await drainPending();

    expect(onoffPuts(putSpy)).not.toContain(true);
  });

  // 4 kWh by 14:00 on a 2 kW element needs every hour left, this one included.
  const seedBookedSmartTask = () => {
    mockHomeyInstance.settings.set(COMBINED_PRICES, {
      version: 2,
      days: {
        '2026-07-25': {
          hours: Array.from({ length: 24 }, (_, hour) => ({
            startsAt: new Date(Date.UTC(2026, 6, 25, hour)).toISOString(),
            total: 70,
            isCheap: false,
            isExpensive: false,
          })),
        },
      },
      avgPrice: 70,
      lowThreshold: 60,
      highThreshold: 80,
      priceScheme: 'norway',
      priceUnit: 'øre/kWh',
    });
    mockHomeyInstance.settings.set(`deferred_objective.${DEVICE}`, {
      enabled: true,
      kind: 'energy',
      enforcement: 'soft',
      targetEnergyKWh: 4,
      deadlineAtMs: NOW_MS + 2 * HOUR_MS,
    });
  };
  const holdKey = `${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${DEVICE}`;

  it('turns a held device on for an hour its smart task books, which ends the hold', async () => {
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });
    seedBookedSmartTask();

    const putSpy = await startApp();
    await advancePolls(60);
    await drainUntilCalledWith(putSpy, cap(DEVICE, 'onoff'), { value: true });
    await advancePolls(6);
    await drainPending();

    expect(onoffPuts(putSpy)).toContain(true);
    // Ended by the device being on, the way any hold ends.
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(holdKey);
  });

  it('keeps the hold through a booked hour in which PELS never turns the device on', async () => {
    // A capacity dry run plans the hour but sends nothing. The hold must not be
    // spent on an hour the device never ran in, or PELS would start it later
    // as an ordinary device once the task is gone.
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHeater()]) });
    seedSettings({ optedIn: true, held: true });
    seedBookedSmartTask();
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);

    const putSpy = await startApp();
    await advancePolls(60);
    await drainPending();

    expect(onoffPuts(putSpy)).not.toContain(true);
    expect(mockHomeyInstance.settings.getKeys()).toContain(holdKey);
  });
});
