import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestPlanSnapshotForTests, MockDevice, MockDriver, mockHomeyInstance, resetMockHomey, setMockDrivers,
} from '../mocks/homey';
import { drainPending } from '../utils/asyncDrain';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN, CAPACITY_ENABLED, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_PERIOD_MINUTES,
  CONTROLLABLE_DEVICES, MANAGED_DEVICES, OPERATING_MODE_SETTING, OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';

const HEATER_W = 2000;
const BACKGROUND_W = 2600;

const poll = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(10_000);
  await drainPending();
};

// Only Homey reads, writes and the clock are mocked: the meter follows the
// heaters, which follow PELS's writes. In simulation nothing is written, so
// the meter keeps both heaters' draw.
const boot = async (simulating: boolean) => {
  const kitchen = new MockDevice('kitchen', 'Kitchen heater', ['onoff', 'measure_power'], 'heater');
  const garage = new MockDevice('garage', 'Garage heater', ['onoff', 'measure_power'], 'heater');
  for (const device of [kitchen, garage]) {
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', HEATER_W);
  }
  setMockDrivers({ driverA: new MockDriver('driverA', [kitchen, garage]) });
  const settings = mockHomeyInstance.settings;
  settings.set('power_source', 'homey_energy');
  settings.set('homey_energy_meter_device_id', 'meter-main');
  settings.set(CAPACITY_ENABLED, true);
  settings.set(CAPACITY_PERIOD_MINUTES, 60);
  settings.set(CAPACITY_LIMIT_KW, 5);
  settings.set(CAPACITY_MARGIN_KW, 0.2);
  settings.set(CAPACITY_DRY_RUN, simulating);
  settings.set(OPERATING_MODE_SETTING, 'Home');
  settings.set(CONTROLLABLE_DEVICES, { kitchen: true, garage: true });
  settings.set(MANAGED_DEVICES, { kitchen: true, garage: true });
  settings.set('capacity_priorities', { Home: { kitchen: 1, garage: 2 } });
  settings.set(OVERSHOOT_BEHAVIORS, { kitchen: { action: 'turn_off' }, garage: { action: 'turn_off' } });
  const drawW = async (device: MockDevice) => ((await device.getCapabilityValue('onoff')) === true ? HEATER_W : 0);
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const totalW = BACKGROUND_W + await drawW(kitchen) + await drawW(garage);
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: totalW } }] };
    }
    return originalGet(path);
  });
  const originalPut = mockHomeyInstance.api.put.bind(mockHomeyInstance.api);
  const put = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path, body) => {
    const result = await originalPut(path, body);
    const device = path.includes('/kitchen/') ? kitchen : garage;
    if (path.endsWith('/onoff')) {
      await device.setCapabilityValue('measure_power', (body as { value: boolean }).value ? HEATER_W : 0);
    }
    return result;
  });
  const app = createApp();
  await app.onInit();
  return { app, kitchen, garage, put };
};

const plannedShed = (): string => (getLatestPlanSnapshotForTests()?.devices ?? [])
  .filter((device: { plannedState: string }) => device.plannedState === 'shed')
  .map((device: { id: string }) => device.id)
  .sort()
  .join('+') || '-';

type HourRun = {
  timeline: string[];
  usedKWh: number;
  withControlOn: { usedKWh: number; drawKw: number } | undefined;
};

const runHour = async (simulating: boolean): Promise<HourRun> => {
  await boot(simulating);
  const timeline: string[] = [];
  // From :00 to the end of the hour, every 10 s.
  for (let i = 0; i < 359; i += 1) {
    await poll();
    timeline.push(plannedShed());
  }
  const meta = getLatestPlanSnapshotForTests()?.meta;
  return { timeline, usedKWh: meta?.usedKWh ?? 0, withControlOn: meta?.withControlOn };
};

describe('simulation paces the period as live control would', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'] });
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    resetMockHomey();
    setMockDrivers({});
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // In simulation the meter keeps both heaters' draw, so the hour's measured
  // energy runs ahead of the hour live control would have had. Paced from that,
  // simulation used to add the kitchen heater six minutes in and hold it all
  // hour, which live control never does.
  it('plans the same limits as live control, reading by reading, through an hour', async () => {
    const live = await runHour(false);
    await cleanupApps();
    vi.restoreAllMocks();
    resetMockHomey();
    setMockDrivers({});
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const simulated = await runHour(true);

    expect(live.timeline.every((shed) => shed === 'garage')).toBe(true);
    expect(simulated.timeline).toEqual(live.timeline);
    // The energy shown as used stays measured: in simulation both heaters ran.
    expect(simulated.usedKWh).toBeGreaterThan(live.usedKWh + 1.5);
    // Beside it, simulation gives the hour as live control had it.
    expect(live.withControlOn).toBeUndefined();
    // Both heaters drew 6.6 kW in simulation; with control on the house drew 4.6 kW.
    expect(simulated.withControlOn?.usedKWh).toBeCloseTo(simulated.usedKWh * (4.6 / 6.6), 1);
    expect(simulated.withControlOn?.drawKw).toBeCloseTo(4.6, 1);
  });
});
