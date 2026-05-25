import { AppSnapshotHelpers } from '../lib/app/appSnapshotHelpers';
import { disableUnsupportedDevices } from '../lib/app/appDeviceSupport';
import { TimerRegistry } from '../lib/app/timerRegistry';
import { STALE_DEVICE_OBSERVATION_MS } from '../lib/observer/observationFreshness';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
} from '../lib/utils/settingsKeys';
import { mockHomeyInstance } from './mocks/homey';

describe('appSnapshotHelpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restarting periodic snapshot refresh replaces existing timers instead of duplicating them', () => {
    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot: vi.fn() } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn().mockResolvedValue(undefined),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });

    helper.startPeriodicSnapshotRefresh();
    const initialTimerCount = vi.getTimerCount();
    expect(initialTimerCount).toBeGreaterThan(0);

    helper.startPeriodicSnapshotRefresh();
    expect(vi.getTimerCount()).toBe(initialTimerCount);

    helper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tags headroom syncs from snapshot refresh with snapshot_refresh reconciliation context', async () => {
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const syncLivePlanState = vi.fn().mockResolvedValue(undefined);
    const syncHeadroomCardState = vi.fn();
    const snapshot = [{
      id: 'dev-1',
      name: 'Heater',
      currentOn: true,
      powerKw: 1.2,
      expectedPowerKw: 1.2,
      measuredPowerKw: 1.2,
    }];
    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState,
        syncHeadroomCardState,
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => snapshot as any,
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });

    await (helper as any).runSnapshotRefreshCycle({ refreshSnapshot } as any, { targeted: true });

    expect(syncHeadroomCardState).toHaveBeenCalledWith({
      devices: [{
        ...snapshot[0],
        managed: true,
        controllable: true,
      }],
      cleanupMissingDevices: true,
      reconciliationContext: 'snapshot_refresh',
    });
  });

  it('enforces unsupported-device settings before syncing plan and headroom state', async () => {
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];
    const syncLivePlanState = vi.fn(async () => {
      callOrder.push('syncLivePlanState');
    });
    const syncHeadroomCardState = vi.fn(() => {
      callOrder.push('syncHeadroomCardState');
    });
    const disableUnsupported = vi.fn(() => {
      callOrder.push('disableUnsupportedDevices');
    });
    const emitSettingsUiDevicesUpdated = vi.fn(() => {
      callOrder.push('emitSettingsUiDevicesUpdated');
    });
    const snapshot = [{
      id: 'dev-1',
      name: 'Unsupported Socket',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
    }];
    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState,
        syncHeadroomCardState,
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => snapshot as any,
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: disableUnsupported,
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated,
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });

    await (helper as any).runSnapshotRefreshCycle({ refreshSnapshot } as any, { targeted: true });

    expect(callOrder).toEqual([
      'disableUnsupportedDevices',
      'syncLivePlanState',
      'syncHeadroomCardState',
      'emitSettingsUiDevicesUpdated',
    ]);
  });

  it('lets snapshot sync collaborators observe settings after unsupported-device enforcement', async () => {
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { 'socket-1': true });
    mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { 'socket-1': true });
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const settingsSeenByLivePlan: unknown[] = [];
    const settingsSeenByHeadroom: unknown[] = [];
    const snapshot = [{
      id: 'socket-1',
      name: 'Unsupported Socket',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
      managed: true,
      controllable: true,
    }];
    const syncHeadroomCardState = vi.fn(() => {
      settingsSeenByHeadroom.push(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES));
    });
    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn(async () => {
          settingsSeenByLivePlan.push(mockHomeyInstance.settings.get(MANAGED_DEVICES));
        }),
        syncHeadroomCardState,
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => snapshot as any,
      resolveManagedState: (deviceId) => (
        mockHomeyInstance.settings.get(MANAGED_DEVICES) as Record<string, boolean>
      )[deviceId] !== false,
      isCapacityControlEnabled: (deviceId) => (
        mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES) as Record<string, boolean>
      )[deviceId] !== false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: (nextSnapshot) => disableUnsupportedDevices({
        snapshot: nextSnapshot,
        settings: mockHomeyInstance.settings as any,
        logDebug: vi.fn(),
      }),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });

    await (helper as any).runSnapshotRefreshCycle({ refreshSnapshot } as any, { targeted: true });

    expect(settingsSeenByLivePlan).toEqual([{ 'socket-1': false }]);
    expect(settingsSeenByHeadroom).toEqual([{ 'socket-1': false }]);
    expect(syncHeadroomCardState).toHaveBeenCalledWith({
      devices: [{
        ...snapshot[0],
        managed: false,
        controllable: false,
      }],
      cleanupMissingDevices: true,
      reconciliationContext: 'snapshot_refresh',
    });
  });

  it('does not trigger a recursive snapshot refresh on fresh install when an unsupported device is present', async () => {
    // Bug regression: on first boot, `disableUnsupportedDevices` used to write
    // `{id: false}` for every unsupported device — even when the map had no
    // existing key for that id. Each write fired the MANAGED_DEVICES settings
    // handler, which queued another snapshot refresh, producing a recursive
    // refresh on every fresh boot. Fix: only demote IDs whose current value
    // is explicitly `true`.
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const snapshot = [{
      id: 'socket-1',
      name: 'Unsupported Socket',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
    }];
    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn().mockResolvedValue(undefined),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => snapshot as any,
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: (nextSnapshot) => disableUnsupportedDevices({
        snapshot: nextSnapshot,
        settings: mockHomeyInstance.settings as any,
        logDebug: vi.fn(),
      }),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });

    await (helper as any).runSnapshotRefreshCycle({ refreshSnapshot } as any, { targeted: true });

    // No write to MANAGED_DEVICES means the settings handler is never fired,
    // so no recursive snapshot refresh is queued.
    expect(mockHomeyInstance.settings.get(MANAGED_DEVICES)).toBeUndefined();
    expect(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES)).toBeUndefined();
  });

  it('emits flow-backed refresh requests only once across queued snapshot cycles', async () => {
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const helperRef: { current?: AppSnapshotHelpers } = {};
    const emitFlowBackedRefreshRequests = vi.fn(async () => {
      await helperRef.current?.refreshTargetDevicesSnapshot({ emitFlowBackedRefresh: false });
    });

    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn().mockResolvedValue(undefined),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => ['dev-1']),
      emitFlowBackedRefreshRequests,
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });
    helperRef.current = helper;
    (helper as any).staleObservationRefreshStopped = false;

    await helper.refreshTargetDevicesSnapshot();

    expect(emitFlowBackedRefreshRequests).toHaveBeenCalledTimes(1);
    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
  });

  it('counts queued snapshot refresh requests as coalesced rebuild triggers', async () => {
    const deferred = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
      });
      return { promise, resolve };
    })();
    const refreshSnapshot = vi.fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(undefined);

    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn().mockResolvedValue(undefined),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });
    (helper as any).staleObservationRefreshStopped = false;

    const firstRefresh = helper.refreshTargetDevicesSnapshot();
    await Promise.resolve();
    // Overlapping callers await the in-flight refresh now (TODO 728), so do
    // not block the test on the second call before releasing the first cycle.
    const secondRefresh = helper.refreshTargetDevicesSnapshot();
    deferred.resolve();
    await firstRefresh;
    await secondRefresh;

    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
  });

  it('overlapping refresh calls await the in-flight cycle instead of returning immediately', async () => {
    const deferred = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
      });
      return { promise, resolve };
    })();
    const refreshSnapshot = vi.fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue(undefined);

    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn().mockResolvedValue(undefined),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      seedMissingModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });
    (helper as any).staleObservationRefreshStopped = false;

    const firstRefresh = helper.refreshTargetDevicesSnapshot();
    await Promise.resolve();
    const secondRefresh = helper.refreshTargetDevicesSnapshot();
    let secondSettled = false;
    void secondRefresh.then(() => { secondSettled = true; });
    // The second call must not resolve before the in-flight cycle (still
    // gated on `deferred`) completes — that is the contract behind TODO 728:
    // overlapping `/ui_refresh_devices` calls must see the post-refresh
    // snapshot, not the pre-refresh stale snapshot.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    deferred.resolve();
    await firstRefresh;
    await secondRefresh;
    expect(secondSettled).toBe(true);
  });

  describe('refreshStaleDeviceObservations contract', () => {
    // Pins the by-design behavior investigated for TODO ~line 2445 / prod log
    // (`/tmp/pels/start.main.0a4464c3.stdout.log`) — repeated
    // `stale_device_observation_refresh` emits with `freshAfterRefreshDevices: 0`.
    //
    // Root cause = case (a): `lastFreshDataMs` is derived in `parseDevice`
    // (`resolveLastFreshDataMs` in `lib/device/transport/managerParseSnapshot.ts`)
    // from the highest Homey per-capability `lastUpdated`. Many Homey drivers
    // (Z-Wave/Zigbee thermostats, in particular) only advance `lastUpdated`
    // when a capability genuinely reports a new value. A targeted refresh that
    // re-fetches the device snapshot does NOT bump `lastUpdated`; Homey serves
    // the cached capability value with the same timestamp. The 40-minute
    // `STALE_DEVICE_OBSERVATION_MS` window is the backstop. Devices become
    // fresh again on the next genuine capability emit (confirmed by the
    // `device_became_fresh` events in the same prod log). Therefore:
    //  - Fresh after refresh ⇔ Homey returned a *newer* per-capability
    //    `lastUpdated` than the prior snapshot recorded.
    //  - Still-stale after refresh ⇔ Homey returned no newer `lastUpdated`
    //    (the device's last observation timestamp IS the reason — emitted via
    //    `device_became_stale` per-device on the transition).
    const baseTimeMs = Date.UTC(2026, 2, 21, 10, 0, 0);

    type StaleRefreshDevice = {
      id: string;
      name: string;
      lastFreshDataMs: number;
    };

    function makeSnapshotDevice(id: string, lastFreshDataMs: number, name = `dev ${id}`): StaleRefreshDevice {
      return { id, name, lastFreshDataMs };
    }

    function makeStaleSnapshotDevice(id: string, nowMs: number, name = `dev ${id}`): StaleRefreshDevice {
      return makeSnapshotDevice(id, nowMs - STALE_DEVICE_OBSERVATION_MS - 60 * 1000, name);
    }

    function makeFreshSnapshotDevice(id: string, nowMs: number, name = `dev ${id}`): StaleRefreshDevice {
      return makeSnapshotDevice(id, nowMs - 1_000, name);
    }

    function makeHelperForRefreshContract(options: {
      snapshotRef: { current: StaleRefreshDevice[] };
      infoSpy: ReturnType<typeof vi.fn>;
      currentMs: { value: number };
      refreshSnapshot?: ReturnType<typeof vi.fn>;
    }) {
      const refreshSnapshot = options.refreshSnapshot ?? vi.fn().mockResolvedValue(undefined);
      return new AppSnapshotHelpers({
        homey: mockHomeyInstance as any,
        timers: new TimerRegistry(),
        getDeviceManager: () => ({ refreshSnapshot } as any),
        getPlanEngine: () => undefined,
        getPlanService: () => ({
          syncLivePlanState: vi.fn().mockResolvedValue(undefined),
          syncHeadroomCardState: vi.fn(),
          getLatestPlanSnapshot: vi.fn(),
        } as any),
        getLatestTargetSnapshot: () => options.snapshotRef.current as any,
        resolveManagedState: () => true,
        isCapacityControlEnabled: () => true,
        getStructuredLogger: (component) => (component === 'devices' ? ({
          info: options.infoSpy,
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        } as any) : undefined),
        logDebug: vi.fn(),
        error: vi.fn(),
        getNow: () => new Date(options.currentMs.value),
        logPeriodicStatus: vi.fn(),
        disableUnsupportedDevices: vi.fn(),
        seedMissingModeTargets: vi.fn(),
        getFlowReportedDeviceIds: vi.fn(() => []),
        emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
        emitSettingsUiDevicesUpdated: vi.fn(),
        recordPowerSample: vi.fn().mockResolvedValue(undefined),
      });
    }

    function emitsOfEvent(infoSpy: ReturnType<typeof vi.fn>, event: string): Array<Record<string, unknown>> {
      return infoSpy.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is Record<string, unknown> => (arg as { event?: string })?.event === event);
    }

    it('counts a device as fresh once refresh produces a newer lastFreshDataMs and as still-stale when it does not', async () => {
      const currentMs = { value: baseTimeMs };
      // Two stale devices going in. The refresh mock simulates Homey behavior:
      //  - dev-fresh: capability genuinely changed value, so the parsed
      //    snapshot has a newer `lastFreshDataMs` (within the window).
      //  - dev-still-stale: capability did not change value, so Homey returns
      //    the same cached `lastUpdated` and the parsed snapshot keeps the
      //    pre-refresh stale `lastFreshDataMs` (case (a), by design).
      const snapshotRef = {
        current: [
          makeStaleSnapshotDevice('dev-fresh', currentMs.value, 'Therm A'),
          makeStaleSnapshotDevice('dev-still-stale', currentMs.value, 'Therm B'),
        ],
      };
      const infoSpy = vi.fn();
      const refreshSnapshot = vi.fn().mockImplementation(async () => {
        snapshotRef.current = [
          makeFreshSnapshotDevice('dev-fresh', currentMs.value, 'Therm A'),
          // dev-still-stale unchanged — Homey returned cached state.
          makeStaleSnapshotDevice('dev-still-stale', currentMs.value, 'Therm B'),
        ];
      });
      const helper = makeHelperForRefreshContract({ snapshotRef, infoSpy, currentMs, refreshSnapshot });

      await helper.refreshStaleDeviceObservations();

      // refreshSnapshot was actually invoked (targeted refresh path).
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);

      // The structured counter splits the two devices correctly:
      // fresh device transitions to fresh, still-stale device stays stale.
      const refreshEmits = emitsOfEvent(infoSpy, 'stale_device_observation_refresh');
      expect(refreshEmits).toHaveLength(1);
      expect(refreshEmits[0]).toMatchObject({
        event: 'stale_device_observation_refresh',
        staleDevices: 2,
        devicesTotal: 2,
        refreshedDevices: 2,
        freshAfterRefreshDevices: 1,
        stillStaleAfterRefreshDevices: 1,
        loggedStillStaleDevices: 1,
      });
    });

    it('emits device_became_stale with the last observation timestamp as the still-stale reason', async () => {
      // The "clear reason" a still-stale device exposes is its actual last
      // observation timestamp — surfaced per-device via `device_became_stale`
      // when the transition first happened. `isDeviceObservationStale` in
      // `logDeviceFreshnessTransitions` calls `Date.now()` directly (not the
      // injected `getNow`), so the simulated wall clock must move via
      // `vi.setSystemTime`.
      const transitionStartMs = baseTimeMs;
      vi.setSystemTime(new Date(transitionStartMs));
      const currentMs = { value: transitionStartMs };
      const snapshotRef = {
        current: [makeFreshSnapshotDevice('dev-still-stale', currentMs.value, 'Therm B')],
      };
      const infoSpy = vi.fn();
      const helper = makeHelperForRefreshContract({ snapshotRef, infoSpy, currentMs });

      // First cycle: device is fresh, no transition log yet (initial sample).
      await helper.refreshStaleDeviceObservations();
      // Advance into stale territory and re-run: device transitions
      // fresh → stale and emits `device_became_stale` with its last
      // observation timestamp as the explicit reason.
      currentMs.value += STALE_DEVICE_OBSERVATION_MS + 60_000;
      vi.setSystemTime(new Date(currentMs.value));
      await helper.refreshStaleDeviceObservations();

      const becameStale = emitsOfEvent(infoSpy, 'device_became_stale');
      expect(becameStale).toHaveLength(1);
      expect(becameStale[0]).toMatchObject({
        event: 'device_became_stale',
        deviceId: 'dev-still-stale',
        deviceName: 'Therm B',
        source: 'stale_observation_check',
      });
      expect(typeof becameStale[0]!.lastObservationAt).toBe('string');
      expect(typeof becameStale[0]!.ageMs).toBe('number');
      expect(becameStale[0]!.ageMs as number).toBeGreaterThanOrEqual(STALE_DEVICE_OBSERVATION_MS);
    });
  });

  describe('stale_device_observation_refresh log backoff', () => {
    const STALE_LOG_BACKOFF_MS = 15 * 60 * 1000;
    const REFRESH_INTERVAL_MS = 60 * 1000;
    const baseTimeMs = Date.UTC(2026, 2, 21, 10, 0, 0);

    type StaleDevice = {
      id: string;
      name: string;
      lastFreshDataMs: number;
    };

    function makeStaleDevice(id: string, nowMs: number, name = `dev ${id}`): StaleDevice {
      return {
        id,
        name,
        lastFreshDataMs: nowMs - STALE_DEVICE_OBSERVATION_MS - 60 * 1000,
      };
    }

    function makeHelperForStaleRefresh(options: {
      snapshotRefByTime: { current: StaleDevice[] };
      infoSpy: ReturnType<typeof vi.fn>;
      currentMs: { value: number };
    }) {
      const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
      return new AppSnapshotHelpers({
        homey: mockHomeyInstance as any,
        timers: new TimerRegistry(),
        getDeviceManager: () => ({ refreshSnapshot } as any),
        getPlanEngine: () => undefined,
        getPlanService: () => ({
          syncLivePlanState: vi.fn().mockResolvedValue(undefined),
          syncHeadroomCardState: vi.fn(),
          getLatestPlanSnapshot: vi.fn(),
        } as any),
        getLatestTargetSnapshot: () => options.snapshotRefByTime.current as any,
        resolveManagedState: () => true,
        isCapacityControlEnabled: () => true,
        getStructuredLogger: (component) => (component === 'devices' ? ({
          info: options.infoSpy,
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        } as any) : undefined),
        logDebug: vi.fn(),
        error: vi.fn(),
        getNow: () => new Date(options.currentMs.value),
        logPeriodicStatus: vi.fn(),
        disableUnsupportedDevices: vi.fn(),
        seedMissingModeTargets: vi.fn(),
        getFlowReportedDeviceIds: vi.fn(() => []),
        emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
        emitSettingsUiDevicesUpdated: vi.fn(),
        recordPowerSample: vi.fn().mockResolvedValue(undefined),
      });
    }

    function staleRefreshEmits(infoSpy: ReturnType<typeof vi.fn>): unknown[] {
      return infoSpy.mock.calls
        .map((call) => call[0])
        .filter((arg) => (arg as { event?: string })?.event === 'stale_device_observation_refresh');
    }

    it('bounds stale_device_observation_refresh emits to ~once per 15-minute window per device across 100 cycles', async () => {
      const currentMs = { value: baseTimeMs };
      const snapshotRefByTime = { current: [makeStaleDevice('dev-1', currentMs.value)] };
      const infoSpy = vi.fn();
      const helper = makeHelperForStaleRefresh({ snapshotRefByTime, infoSpy, currentMs });

      const totalCycles = 100;
      for (let cycle = 0; cycle < totalCycles; cycle += 1) {
        // Keep the device persistently stale by walking its lastFreshDataMs
        // forward in lockstep with the simulated clock — exactly the shape of
        // a Homey driver that only republishes per-capability `lastUpdated`
        // on value change.
        snapshotRefByTime.current = [makeStaleDevice('dev-1', currentMs.value)];
        await helper.refreshStaleDeviceObservations();
        currentMs.value += REFRESH_INTERVAL_MS;
      }

      const emits = staleRefreshEmits(infoSpy);
      // 100 minutes at one log per 15-minute window per device = ceil(100/15)
      // = 7 emits. With the first cycle always emitting we expect at most 7.
      expect(emits.length).toBeGreaterThanOrEqual(1);
      expect(emits.length).toBeLessThanOrEqual(
        Math.ceil((totalCycles * REFRESH_INTERVAL_MS) / STALE_LOG_BACKOFF_MS),
      );
      expect(emits[0]).toMatchObject({
        event: 'stale_device_observation_refresh',
        stillStaleAfterRefreshDevices: 1,
      });
    });

    it('resets backoff after a successful refresh so the device can re-emit if it stalls again', async () => {
      const currentMs = { value: baseTimeMs };
      const snapshotRefByTime = { current: [makeStaleDevice('dev-1', currentMs.value)] };
      const infoSpy = vi.fn();
      const helper = makeHelperForStaleRefresh({ snapshotRefByTime, infoSpy, currentMs });

      // First cycle: stale, first emit lands.
      await helper.refreshStaleDeviceObservations();
      expect(staleRefreshEmits(infoSpy).length).toBe(1);

      // Second cycle still stale, well inside the backoff window: suppressed.
      currentMs.value += REFRESH_INTERVAL_MS;
      snapshotRefByTime.current = [makeStaleDevice('dev-1', currentMs.value)];
      await helper.refreshStaleDeviceObservations();
      expect(staleRefreshEmits(infoSpy).length).toBe(1);

      // Third cycle: device recovers (fresh observation). No stale emit, and
      // the backoff entry should be cleared.
      currentMs.value += REFRESH_INTERVAL_MS;
      snapshotRefByTime.current = [{
        id: 'dev-1',
        name: 'dev dev-1',
        lastFreshDataMs: currentMs.value - 1_000,
      } as any];
      await helper.refreshStaleDeviceObservations();
      expect(staleRefreshEmits(infoSpy).length).toBe(1);

      // Fourth cycle: device stalls again, still inside the original
      // 15-minute window. Because recovery cleared the backoff, a fresh emit
      // must fire — proving reset-on-recovery works.
      currentMs.value += REFRESH_INTERVAL_MS;
      snapshotRefByTime.current = [makeStaleDevice('dev-1', currentMs.value)];
      await helper.refreshStaleDeviceObservations();
      expect(staleRefreshEmits(infoSpy).length).toBe(2);
    });
  });
});
