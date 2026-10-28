// SDK-boundary e2e: urgent capacity pressure bypasses discretionary waiting.
// A newly commanded electrical reduction remains pending until observed; it
// must not raise an out-of-options alert merely because the meter still shows
// the pre-command draw. Once every useful reduction has delivered and the
// measured breach remains, the alert must fire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import { drainPending } from '../utils/asyncDrain';

const DEVICE_ID = 'heater';
const ONOFF_CAP = `manager/devices/device/${DEVICE_ID}/capability/onoff`;
const POLL_MS = 10_000;

let homePowerW = 0;
const reportHomePowerThroughHomeyEnergy = (): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: homePowerW } }] };
    }
    return originalGet(path);
  });
};

const shortfallAlerts = (): unknown[] => mockHomeyInstance.flow._triggerCardTriggers.capacity_shortfall ?? [];

type StructuredRecord = Record<string, unknown> & { event?: string };

/** Boots the real app, collecting the structured records it writes through `app.log`. */
const bootApp = async (): Promise<StructuredRecord[]> => {
  const app = createApp();
  const records: StructuredRecord[] = [];
  const originalLog = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        const parsed = JSON.parse(arg) as StructuredRecord;
        if (parsed.event) records.push(parsed);
      } catch { /* not a structured line */ }
    }
    return originalLog(...args);
  };
  await app.onInit();
  return records;
};

/** Records written after `fromIndex` from a plan build over the hard-cap threshold. */
const hardCapBreachRecordsSince = (records: StructuredRecord[], fromIndex: number): StructuredRecord[] => records
  .slice(fromIndex)
  .filter((record) => typeof record.hardCapHeadroomKw === 'number' && record.hardCapHeadroomKw < 0);

const configureHome = (managedDeviceId: string): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
  // A 4 kW soft limit under the 5 kW hard cap, so PELS can limit a device
  // without the house being over the cap.
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 1);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('controllable_devices', { [managedDeviceId]: true });
  mockHomeyInstance.settings.set('managed_devices', { [managedDeviceId]: true });
};

/** Advances poll by poll until `done` holds; fails loudly rather than hanging. */
const pollUntil = async (done: () => boolean, maxPolls: number): Promise<void> => {
  for (let poll = 0; poll < maxPolls && !done(); poll += 1) {
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await drainPending();
  }
  expect(done()).toBe(true);
};

describe('Hard-cap alert while electrical relief is pending (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    resetMockHomey();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('answers an actual-cap breach immediately, alerts only after its electrical options are exhausted', async () => {
    const heater = new MockDevice(DEVICE_ID, 'Heater', ['onoff', 'measure_power', 'meter_power'], 'heater');
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 2000);
    await heater.setCapabilityValue('meter_power', 100);
    setMockDrivers({ driverA: new MockDriver('driverA', [heater]) });
    configureHome(DEVICE_ID);
    homePowerW = 4600;
    reportHomePowerThroughHomeyEnergy();
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const onoffWrites = (value: boolean): number => putSpy.mock.calls
      .filter(([path, body]) => path === ONOFF_CAP && (body as { value?: unknown }).value === value).length;

    const records = await bootApp();

    // 1. Over the soft limit with the heater on: PELS limits it.
    await pollUntil(() => onoffWrites(false) === 1, 6);
    await heater.setCapabilityValue('measure_power', 0);

    // 2. The house calms down: PELS resumes the heater once its cooldown allows.
    homePowerW = 1500;
    await pollUntil(() => onoffWrites(true) === 1, 60);

    //3. A new actual-cap breach gets no discretionary waiting, even after
    // PELS's own resume. The requested2kW electrical reduction is still a real
    // pending option until the device and whole-home meter can show its effect.
    await heater.setCapabilityValue('measure_power', 2000);
    homePowerW = 12_000;
    const recordsBeforeBreach = records.length;
    await pollUntil(() => onoffWrites(false) === 2, 6);
    expect(hardCapBreachRecordsSince(records, recordsBeforeBreach)).not.toEqual([]);
    expect(shortfallAlerts()).toEqual([]);

    //4. The limit landed and the house is still over the cap: now PELS is out
    //    of options, and says so once.
    await heater.setCapabilityValue('measure_power', 0);
    await pollUntil(() => shortfallAlerts().length > 0, 6);
    expect(shortfallAlerts()).toHaveLength(1);
  });

  it('fires the hard-cap alert when the only load left is on a device PELS cannot switch', async () => {
    // Managed and drawing, but its on/off is read-only: no shed can relieve it.
    const socket = new MockDevice('socket', 'Socket', ['onoff', 'measure_power', 'meter_power'], 'socket');
    socket.setCapabilityMetadata('onoff', { setable: false });
    await socket.setCapabilityValue('onoff', true);
    await socket.setCapabilityValue('measure_power', 2000);
    await socket.setCapabilityValue('meter_power', 100);
    setMockDrivers({ driverA: new MockDriver('driverA', [socket]) });
    configureHome('socket');
    // Under the soft limit first, so the socket is in the plan before the breach
    // is judged: an incident on a house PELS knows no devices in proves nothing.
    homePowerW = 3000;
    reportHomePowerThroughHomeyEnergy();
    const records = await bootApp();
    await pollUntil(() => records.some((record) => record.event === 'plan_rebuild_completed'
      && record.controlledDevices === 1), 6);
    expect(shortfallAlerts()).toEqual([]);

    homePowerW = 12_000;
    const recordsBeforeBreach = records.length;
    await pollUntil(() => shortfallAlerts().length > 0, 6);
    expect(hardCapBreachRecordsSince(records, recordsBeforeBreach)).not.toEqual([]);
    expect(records.find((record) => record.event === 'hard_cap_shortfall_detected')).toMatchObject({
      controlledDevices: 1,
      remainingActionableControlledLoad: false,
    });
    expect(shortfallAlerts()).toHaveLength(1);
  });
});
