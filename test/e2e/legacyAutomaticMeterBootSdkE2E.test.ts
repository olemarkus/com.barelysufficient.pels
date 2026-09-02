import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

// An install with no whole-home meter chosen: a legacy Automatic install
// (Homey Energy source, meter stored as null) or a fresh install with no
// source at all. With exactly one whole-home meter in the live report and the
// device registry, PELS names it itself shortly after boot, through the same
// save the owner's pick makes; with several, or with readings already
// arriving through a Flow, it names nothing, the Main home stays fenced and
// the owner picks under Limits & safety.

type CapturedEvent = { event?: string };

const cumulative = (id: string, watts: number) => ({ type: 'cumulative', id, values: { W: watts } });

const installLiveReport = (items: unknown[]): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return { items };
    return originalGet(path);
  });
};

const bootWithEventCapture = async (): Promise<{ events: CapturedEvent[]; app: ReturnType<typeof createApp> }> => {
  // No seeded power measurement: an install with no meter chosen has received
  // nothing, and the adoption reads a sample admitted since boot as "readings
  // already flowing".
  const app = createApp({ withoutPowerMeasurement: true });
  // Observe ONLY through structured logs at the Homey logging seam (`app.log`
  // / `app.error`), where the Homey destination lands them as JSON. Spy
  // BEFORE `onInit`: the authority warns once, at its first fenced read.
  const events: CapturedEvent[] = [];
  const collect = (...args: unknown[]): void => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        events.push(JSON.parse(arg) as CapturedEvent);
      } catch { /* non-JSON log line */ }
    }
  };
  const origLog = app.log.bind(app);
  const origError = app.error.bind(app);
  app.log = (...args: unknown[]) => { collect(...args); return origLog(...args); };
  app.error = (...args: unknown[]) => { collect(...args); return origError(...args); };
  await app.onInit();
  return { events, app };
};

const hasEvent = (events: CapturedEvent[], name: string): boolean => events.some((e) => e.event === name);

describe('Whole-home meter not chosen at boot (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The meters exist in the device registry (sensor-class power reporters)
  // as well as in the live report: the census cross-checks both.
  const seedManagedHeater = async (...meterIds: string[]): Promise<MockDevice> => {
    const device = new MockDevice('heater-a', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 1000);
    await device.setCapabilityValue('onoff', true);
    const meters = meterIds.map((id) => new MockDevice(id, id, ['measure_power'], 'sensor'));
    setMockDrivers({ driverA: new MockDriver('driverA', [device, ...meters]) });
    mockHomeyInstance.settings.set('managed_devices', { 'heater-a': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'heater-a': true });
    return device;
  };

  it('names the sole meter for a legacy Automatic install and starts reading it', async () => {
    await seedManagedHeater('meter-main');
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', null);
    installLiveReport([cumulative('meter-main', 3_200)]);

    const { events, app } = await bootWithEventCapture();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(mockHomeyInstance.settings.get('homey_energy_meter_device_id')).toBe('meter-main');
    expect(mockHomeyInstance.settings.get('power_source')).toBe('homey_energy');
    expect(hasEvent(events, 'sole_meter_adopted')).toBe(true);
    // The adoption is an ordinary settings change to the rest of the app: the
    // meter handler restarts the poll, and the tracker persists the reading.
    expect(hasEvent(events, 'homey_energy_meter_changed')).toBe(true);
    const tracker = mockHomeyInstance.settings.get('power_tracker_state') as { lastPowerW?: number } | null;
    expect(tracker?.lastPowerW).toBe(3_200);

    await app.onUninit?.();
  });

  it('names the sole meter for a fresh install with no source chosen', async () => {
    await seedManagedHeater('meter-main');
    installLiveReport([cumulative('meter-main', 3_200)]);

    const { events, app } = await bootWithEventCapture();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(mockHomeyInstance.settings.get('homey_energy_meter_device_id')).toBe('meter-main');
    expect(mockHomeyInstance.settings.get('power_source')).toBe('homey_energy');
    expect(hasEvent(events, 'sole_meter_adopted')).toBe(true);
    expect(hasEvent(events, 'power_source_changed')).toBe(true);

    await app.onUninit?.();
  });

  it('names nothing with several meters: keys untouched, Main fenced, the device left as it was', async () => {
    const device = await seedManagedHeater('meter-main', 'meter-garage');
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', null);
    installLiveReport([cumulative('meter-main', 3_200), cumulative('meter-garage', 400)]);

    const { events, app } = await bootWithEventCapture();
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(mockHomeyInstance.settings.get('power_source')).toBe('homey_energy');
    expect(mockHomeyInstance.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(hasEvent(events, 'sole_meter_adoption_not_applicable')).toBe(true);
    expect(hasEvent(events, 'sole_meter_adopted')).toBe(false);
    // The Main-home actuation fence is visible only as the authority's one
    // structured warning; the heater is left exactly as it was.
    expect(hasEvent(events, 'main_home_meter_authority_unavailable')).toBe(true);
    await expect(device.getCapabilityValue('onoff')).resolves.toBe(true);

    await app.onUninit?.();
  });
});

describe('Readings already arriving through a Flow (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the Flow feed on an install that never wrote the source, even with a sole meter on offer', async () => {
    const heater = new MockDevice('heater-a', 'Heater', ['measure_power', 'onoff']);
    await heater.setCapabilityValue('measure_power', 1000);
    const meter = new MockDevice('meter-main', 'meter-main', ['measure_power'], 'sensor');
    setMockDrivers({ driverA: new MockDriver('driverA', [heater, meter]) });
    mockHomeyInstance.settings.set('managed_devices', { 'heater-a': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'heater-a': true });
    installLiveReport([cumulative('meter-main', 3_200)]);

    const { events, app } = await bootWithEventCapture();
    const reportPower = mockHomeyInstance.flow._actionCardListeners.report_power_usage;
    expect(reportPower).toBeDefined();
    // The owner's Flow reports power every 10 s from the moment PELS is up.
    for (let i = 0; i < 30; i += 1) {
      await reportPower({ power: 2_500 });
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(mockHomeyInstance.settings.get('power_source')).toBeNull();
    expect(mockHomeyInstance.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(hasEvent(events, 'sole_meter_adopted')).toBe(false);
    expect(hasEvent(events, 'sole_meter_adoption_not_applicable')).toBe(true);
    const tracker = mockHomeyInstance.settings.get('power_tracker_state') as { lastPowerW?: number } | null;
    expect(tracker?.lastPowerW).toBe(2_500);

    await app.onUninit?.();
  });
});
