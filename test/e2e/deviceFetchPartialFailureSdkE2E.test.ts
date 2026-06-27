// SDK-boundary e2e: a targeted (by-id) snapshot refresh where ONE of the known
// device ids fails its read (a 404 — flaky/removed device) must NOT stall the
// snapshot, and must NOT drop the missed device from the controller's working
// set on a single-cycle miss. A targeted refresh is UPDATE-ONLY: the surviving
// devices commit, the missed device is RETAINED in `latestSnapshot` (still
// planned, still retried next cycle) within a per-device miss grace, and the
// refresh never cascades to the bulk full fetch. Only after GRACE consecutive
// misses is the device treated as genuinely removed and dropped.
//
// THE RULE THIS TEST ENFORCES: nothing internal is mocked. The per-id read is
// simulated at the real Homey SDK seam (`api.get('manager/devices/device/<id>')`
// — the wire path the REST client hits), the whole wired transport + planner +
// observer projection run for real, and the outcome is observed only through
// external seams: the committed snapshot (`deviceManager.getSnapshot()`), the
// decorated plan-device set the planner consumes (`app.latestTargetSnapshot`),
// the observed-state projection, and the structured log the app emits. No PELS
// internals are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import {
  TARGETED_DEVICE_MISS_GRACE_MS,
  TARGETED_DEVICE_MISS_GRACE_READS,
} from '../../lib/device/transport/targetedSnapshotMerge';

const FULL_FETCH_PATH = 'manager/devices/device';
const byIdPath = (deviceId: string) => `manager/devices/device/${deviceId}`;

const DEVICE_IDS = ['dev-a', 'dev-b', 'dev-c', 'dev-d', 'dev-e'] as const;
const FAILING_ID = 'dev-e';

type Structured = { event?: string; failed?: number; succeeded?: number; deviceId?: string };

type IdedSnapshot = { id: string; managed?: boolean };

const buildDevice = async (id: string): Promise<MockDevice> => {
  const device = new MockDevice(id, id.toUpperCase(), ['onoff', 'measure_power'], 'socket');
  await device.setCapabilityValue('onoff', true);
  await device.setCapabilityValue('measure_power', 200);
  return device;
};

const configureManaged = () => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 10);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, true);
  const flags = Object.fromEntries(DEVICE_IDS.map((id) => [id, true]));
  mockHomeyInstance.settings.set('controllable_devices', { ...flags });
  mockHomeyInstance.settings.set('managed_devices', { ...flags });
};

const snapshotIds = (app: { deviceManager: { getSnapshot: () => IdedSnapshot[] } }): string[] =>
  app.deviceManager.getSnapshot().map((d) => d.id);

const planDevice = (app: { latestTargetSnapshot: IdedSnapshot[] }, id: string): IdedSnapshot | undefined =>
  app.latestTargetSnapshot.find((d) => d.id === id);

describe('Targeted refresh with a single failing device id (SDK-boundary e2e)', () => {
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
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retains the missed device on a transient miss, retries it, and drops it only after the grace', async () => {
    const devices = await Promise.all(DEVICE_IDS.map((id) => buildDevice(id)));
    setMockDrivers({ driver: new MockDriver('driver', devices) });
    configureManaged();

    const app = createApp();
    // Observe the app's structured logs (emitted as JSON strings through app.log).
    const events: Structured[] = [];
    const originalLog = app.log.bind(app);
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as Structured;
          if (parsed.event) events.push(parsed);
        } catch { /* non-JSON line */ }
      }
      return originalLog(...args);
    };

    // Boot: the full fetch primes latestSnapshot with all five devices.
    await app.onInit();
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshotIds(app).sort()).toEqual([...DEVICE_IDS].sort());
    expect(app.observedDeviceStateProjection.getObservedState(FAILING_ID)).toBeDefined();
    expect(planDevice(app, FAILING_ID)).toBeDefined();

    // Make the SINGLE by-id read for dev-e fail (404), and count any bulk
    // full-fetch call so we can prove the targeted refresh does not cascade.
    const realGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    let fullFetchCalls = 0;
    let failTargetedRead = true;
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === FULL_FETCH_PATH) {
        fullFetchCalls += 1;
        return realGet(path);
      }
      if (failTargetedRead && path === byIdPath(FAILING_ID)) {
        throw new Error('404');
      }
      return realGet(path);
    });

    // ---- Transient single-cycle miss --------------------------------------
    events.length = 0;
    await app.refreshTargetDevicesSnapshot({ targeted: true });
    await vi.advanceTimersByTimeAsync(1);

    // The missed device is RETAINED in the committed snapshot (update-only).
    expect(snapshotIds(app).sort()).toEqual([...DEVICE_IDS].sort());
    expect(snapshotIds(app)).toContain(FAILING_ID);
    // The PLANNER still builds a plan-device for it, still managed — per-device
    // plan state survives the transient miss (not evicted).
    const missedPlanDevice = planDevice(app, FAILING_ID);
    expect(missedPlanDevice).toBeDefined();
    expect(missedPlanDevice!.managed).not.toBe(false);
    // Observed state retained too.
    expect(app.observedDeviceStateProjection.getObservedState(FAILING_ID)).toBeDefined();
    // No cascade to the bulk full fetch on the targeted cycle.
    expect(fullFetchCalls).toBe(0);
    // Structured log records the partial outcome with the failure count.
    const partial = events.filter((e) => e.event === 'targeted_fetch_partial');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.at(-1)!.failed).toBe(1);
    expect(partial.at(-1)!.succeeded).toBe(4);

    // ---- Recovery on the next successful read -----------------------------
    failTargetedRead = false;
    await app.refreshTargetDevicesSnapshot({ targeted: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshotIds(app)).toContain(FAILING_ID);
    expect(planDevice(app, FAILING_ID)).toBeDefined();

    // ---- Genuine removal: GRACE misses AND the wall-clock floor ------------
    // The per-device grace gates on BOTH a consecutive-miss count AND a
    // wall-clock floor, so advance the faked clock past the floor across the
    // misses (createApp e2e fakes 'Date').
    failTargetedRead = true;
    events.length = 0;
    for (let i = 0; i < TARGETED_DEVICE_MISS_GRACE_READS; i += 1) {
      await app.refreshTargetDevicesSnapshot({ targeted: true });
      await vi.advanceTimersByTimeAsync(TARGETED_DEVICE_MISS_GRACE_MS);
    }
    // After GRACE consecutive misses past the wall-clock floor the device is
    // dropped from latestSnapshot...
    expect(snapshotIds(app)).not.toContain(FAILING_ID);
    expect(planDevice(app, FAILING_ID)).toBeUndefined();
    // ...and its projection entry is pruned (committed-snapshot prune).
    expect(app.observedDeviceStateProjection.getObservedState(FAILING_ID)).toBeUndefined();
    // The grace-exceed transition is logged.
    expect(events.some((e) => e.event === 'targeted_device_miss_grace_exceeded' && e.deviceId === FAILING_ID))
      .toBe(true);
    // Still no cascade to the full fetch throughout.
    expect(fullFetchCalls).toBe(0);
  });
});
