import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

// A legacy Automatic install: Homey Energy source with the meter stored as
// null (or never written). Nothing in the runtime rewrites that shape on the
// owner's behalf any more, even when the live report offers exactly one
// cumulative meter to adopt. The install reads as `unavailable`: the Main
// home stays fenced and the owner picks a meter under Limits & safety.
describe('Legacy Automatic meter shape at boot (SDK-boundary e2e)', () => {
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

  it('never writes a meter or a source for a stored-null selection, and keeps Main fenced', async () => {
    const device = new MockDevice('heater-a', 'Heater', ['measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 1000);
    await device.setCapabilityValue('onoff', true);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', null);
    mockHomeyInstance.settings.set('managed_devices', { 'heater-a': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'heater-a': true });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    const liveReport = vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') {
        return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 3_200 } }] };
      }
      return originalGet(path);
    });
    const keysBefore = [...mockHomeyInstance.settings.getKeys()].sort();

    const app = createApp();
    // Observe ONLY through structured logs at the Homey logging seam (`app.log`
    // / `app.error`), where the Homey destination lands them as JSON. Spy
    // BEFORE `onInit`: the authority warns once, at its first fenced read.
    const events: Array<{ event?: string }> = [];
    const collect = (...args: unknown[]): void => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          events.push(JSON.parse(arg) as { event?: string });
        } catch { /* non-JSON log line */ }
      }
    };
    const origLog = app.log.bind(app);
    const origError = app.error.bind(app);
    app.log = (...args: unknown[]) => { collect(...args); return origLog(...args); };
    app.error = (...args: unknown[]) => { collect(...args); return origError(...args); };
    await app.onInit();
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    const liveReportFetches = liveReport.mock.calls.filter(([path]) => path === 'manager/energy/live');
    expect(liveReportFetches.length).toBeGreaterThan(0);
    expect(mockHomeyInstance.settings.get('power_source')).toBe('homey_energy');
    expect(mockHomeyInstance.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(mockHomeyInstance.settings.getKeys()).not.toContain('main_meter_authority_migration_v1_done');
    // The Main-home actuation fence is visible only as the authority's one
    // structured warning; nothing else in the run names it.
    expect(events.some((e) => e.event === 'main_home_meter_authority_unavailable')).toBe(true);
    // The heater is left exactly as it was: nothing limited, nothing resumed.
    await expect(device.getCapabilityValue('onoff')).resolves.toBe(true);
    // No settings key appeared that names a meter or a source on the owner's behalf.
    const newKeys = mockHomeyInstance.settings.getKeys().filter((key) => !keysBefore.includes(key));
    expect(newKeys.filter((key) => key === 'power_source' || key === 'homey_energy_meter_device_id')).toEqual([]);

    await app.onUninit?.();
  });
});
