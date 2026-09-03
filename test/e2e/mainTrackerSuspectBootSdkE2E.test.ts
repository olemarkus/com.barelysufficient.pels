import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

// The Main home's tracker persistence is the same classified component every
// meter area runs. A boot whose read of `power_tracker_state` is suspect must
// leave the persisted blob alone — the first prune 10 s later included — and
// reopen once settings answer with a valid tracker again.
describe('Main power tracker on a suspect boot read (SDK-boundary e2e)', () => {
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

  it('never persists over an unreadable tracker, and adopts the repaired one', async () => {
    const device = new MockDevice('heater-a', 'Heater', ['measure_power', 'onoff']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    mockHomeyInstance.settings.set('power_source', 'flow');
    mockHomeyInstance.settings.set('power_tracker_state', 'garbage');

    const app = createApp({ withoutPowerMeasurement: true });
    const events: Array<{ event?: string; homeId?: string }> = [];
    const collect = (...args: unknown[]): void => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          events.push(JSON.parse(arg) as { event?: string; homeId?: string });
        } catch { /* non-JSON log line */ }
      }
    };
    const origLog = app.log.bind(app);
    const origError = app.error.bind(app);
    app.log = (...args: unknown[]) => { collect(...args); return origLog(...args); };
    app.error = (...args: unknown[]) => { collect(...args); return origError(...args); };
    await app.onInit();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(events.some((e) => e.event === 'home_power_tracker_reload_suspect' && e.homeId === 'main')).toBe(true);
    expect(mockHomeyInstance.settings.get('power_tracker_state')).toBe('garbage');

    // Settings answer with a valid tracker again (a repair, or the miss passing).
    const repaired = { lastPowerW: 650, lastTimestamp: Date.now() - 60_000 };
    mockHomeyInstance.settings.set('power_tracker_state', repaired);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(events.some((e) => e.event === 'home_power_tracker_reload_recovered' && e.homeId === 'main')).toBe(true);
    expect(app.powerTracker.lastPowerW).toBe(650);

    await app.onUninit?.();
  });
});
