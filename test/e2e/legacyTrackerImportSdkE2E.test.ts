import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps, getStoredPowerTrackerForTests } from '../utils/appTestUtils';

// An install upgrading from the last settings-blob release boots once with
// its history still under `power_tracker_state`. Observed through the SDK
// seam only: the settings key before and after, the store's rows (through the
// shared store-reading helper every persistence e2e uses), and the structured
// log — and the prune that follows persists over the imported rows, never
// back to settings.
describe('legacy tracker import on the first boot after the upgrade (SDK-boundary e2e)', () => {
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

  it('imports the blob into the store, runs on it, and retires the key', async () => {
    const device = new MockDevice('heater-a', 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('power_source', 'flow');
    const hourKey = '2026-01-15T11:00:00.000Z';
    const legacy = {
      lastPowerW: 650,
      lastTimestamp: Date.now() - 60_000,
      buckets: { [hourKey]: 1.5 },
      dailyTotals: { '2026-01-14': 7.5 },
      objectiveProfiles: {},
    };
    mockHomeyInstance.settings.set('power_tracker_state', legacy);

    const app = createApp({ withoutPowerMeasurement: true });
    const events: Array<{ event?: string; homeId?: string }> = [];
    const origLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try { events.push(JSON.parse(arg) as { event?: string; homeId?: string }); } catch { /* prose */ }
      }
      return origLog(...args);
    };
    await app.onInit();

    expect(events.some((e) => e.event === 'legacy_power_tracker_imported' && e.homeId === 'main')).toBe(true);
    expect(mockHomeyInstance.settings.get('power_tracker_state')).toBeNull();
    expect(getStoredPowerTrackerForTests('main')).toMatchObject({ dailyTotals: { '2026-01-14': 7.5 }, buckets: { [hourKey]: 1.5 } });

    // The first prune persists the running tracker over the imported rows,
    // never back to settings.
    const settingsSet = vi.spyOn(mockHomeyInstance.settings, 'set');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settingsSet.mock.calls.some(([key]) => key === 'power_tracker_state')).toBe(false);
    expect(getStoredPowerTrackerForTests('main')?.dailyTotals?.['2026-01-14']).toBe(7.5);
  });
});
