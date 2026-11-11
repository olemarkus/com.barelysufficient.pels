import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../api';
import type { SmartTaskCandidateRequest } from '../../packages/contracts/src/smartTaskEdit';
import { MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainPending } from '../utils/asyncDrain';
import { seedHourlyFlowPricesForTests } from '../helpers/smartTaskPriceSourceFixture';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  CONTROLLABLE_DEVICES, DEBUG_LOGGING_TOPICS, MANAGED_DEVICES, OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

const HOUR_MS = 3_600_000;
const DAY_MS = Date.UTC(2026, 10, 6);
const HIGH = 'higher-task-relay';
const LOW = 'lower-task-relay';
const CHEAP_MS = DAY_MS + 3 * HOUR_MS;
const homey = () => mockHomeyInstance as never;

type PlannedEvent = {
  event: string;
  deviceId: string;
  plannedBuckets: Array<{ startMs: number; plannedUsefulEnergyKWh: number }>;
};

const buildRelay = async (id: string): Promise<MockDevice> => {
  const relay = new MockDevice(id, id, ['onoff', 'measure_power'], 'heater');
  relay.setSettings({ load: 2000 });
  await relay.setCapabilityValue('onoff', true);
  await relay.setCapabilityValue('measure_power', 2000);
  return relay;
};

const request = (deviceId: string, target: number): SmartTaskCandidateRequest => ({
  deviceId, kind: 'energy', target, readyByLocalTime: '08:00',
  deadlineAtMs: DAY_MS + 8 * HOUR_MS,
});

const previewLower = async () => {
  const response = await api.ui_smart_task_create_preview({ homey: homey(), body: request(LOW, 2) });
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(`Preview rejected: ${response.reason}`);
  expect(response.estimate.status).not.toBe('unavailable');
  return response.estimate.scheduledHours.filter((hour) => hour.plannedKWh > 0).map((hour) => hour.startsAtMs);
};

const createHigherReservation = async () => {
  mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['deferred_objectives']);
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 2.1);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('daily_budget_enabled', false);
  mockHomeyInstance.settings.set('price_optimization_enabled', true);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [HIGH]: true, [LOW]: true });
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [HIGH]: true, [LOW]: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [HIGH]: 1, [LOW]: 2 } });
  seedHourlyFlowPricesForTests(DAY_MS, Array.from({ length: 24 }, (_, hour) => (
    hour === 3 || hour === 4 ? 1 : 100
  )));
  const high = await buildRelay(HIGH);
  const low = await buildRelay(LOW);
  setMockDrivers({ relays: new MockDriver('relays', [high, low]) });
  let unreadableInventory = false;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (unreadableInventory && path === 'manager/devices/device') return undefined;
    return path === 'manager/energy/live'
      ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 0 } }] }
      : originalGet(path);
  });
  const app = createApp();
  const planned: PlannedEvent[] = [];
  const originalLog = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const value of args) {
      if (typeof value !== 'string' || !value.startsWith('{')) continue;
      const event = JSON.parse(value) as PlannedEvent;
      if (event.event === 'deferred_objective_horizon_planned') planned.push(event);
    }
    return originalLog(...args);
  };
  await app.onInit();
  // The first observations establish the relays' actual 2 kW draw. They then
  // idle until their future cheap bookings, so no task energy is delivered.
  await high.setCapabilityValue('measure_power', 0);
  await low.setCapabilityValue('measure_power', 0);
  await api.ui_refresh_devices({ homey: homey() });
  await drainPending();
  expect(await api.ui_smart_task_create({ homey: homey(), body: request(HIGH, 4) }))
    .toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(60_000);
  await drainPending();
  const higherPlan = [...planned].reverse().find((event) => event.deviceId === HIGH);
  expect(higherPlan?.plannedBuckets.some((bucket) => (
    bucket.startMs === CHEAP_MS && bucket.plannedUsefulEnergyKWh > 0
  ))).toBe(true);

  return {
    low, planned,
    makeInventoryUnreadable: () => { unreadableInventory = true; },
  };
};

// Homey inventory, Flow-source prices, API requests and the clock drive the
// real observer, task owner, allocator and recorder. No task internals are mocked.
// Accepted roster absence eventually releases a reservation. An unreadable
// inventory response is not accepted absence and must retain the booking.
describe('missing smart-task reservation (SDK boundary)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    resetMockHomey();
    vi.spyOn(mockHomeyInstance.clock, 'getTimezone').mockReturnValue('UTC');
    vi.setSystemTime(DAY_MS + 10 * 60_000);
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('releases the same expired higher reservation in preview and live allocation', async () => {
    const { low, planned } = await createHigherReservation();

    setMockDrivers({ relays: new MockDriver('relays', [low]) });
    await api.ui_refresh_devices({ homey: homey() });
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    expect(await previewLower()).not.toContain(CHEAP_MS);

    // A clock jump represents a long gap; the next real lifecycle timer reads
    // the new clock and accepted roster. No synthetic allocator tick is called.
    vi.setSystemTime(Date.now() + HOUR_MS + 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    const afterGrace = await previewLower();
    expect(afterGrace).toContain(CHEAP_MS);
    // Repeated reads must not restart the missing device's grace.
    expect(await previewLower()).toEqual(afterGrace);

    expect(await api.ui_smart_task_create({ homey: homey(), body: request(LOW, 2) }))
      .toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();
    const liveLower = [...planned].reverse().find((event) => event.deviceId === LOW);
    expect(liveLower?.plannedBuckets.filter((bucket) => bucket.plannedUsefulEnergyKWh > 0)
      .map((bucket) => bucket.startMs)).toEqual(afterGrace);
  });

  it('retains the higher reservation across unreadable inventory reads', async () => {
    const { makeInventoryUnreadable } = await createHigherReservation();

    expect((await api.ui_devices({ homey: homey() })).devices.map((device) => device.id))
      .toEqual(expect.arrayContaining([HIGH, LOW]));
    makeInventoryUnreadable();
    for (let read = 0; read < 3; read += 1) {
      const refreshing = api.ui_refresh_devices({ homey: homey() }).then(
        (payload) => ({ ok: true as const, payload }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      // Failed reads must preserve the accepted, ready device list. In the
      // old path a fabricated[] makes it cold and this API rejects instead.
      expect(await refreshing).toMatchObject({ ok: true });
      if (read === 0) vi.setSystemTime(Date.now() + 5 * 60_000);
    }
    // Cross the reservation's one-hour absence grace too. Only a failed
    // external read has occurred: both registered relays are still here.
    vi.setSystemTime(Date.now() + HOUR_MS + 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await drainPending();

    const devices = (await api.ui_devices({ homey: homey() })).devices;
    expect(devices.map((device) => device.id)).toEqual(expect.arrayContaining([HIGH, LOW]));
    expect(await previewLower()).not.toContain(CHEAP_MS);
  });
});
