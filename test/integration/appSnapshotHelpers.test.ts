import type Homey from 'homey';
import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { PlanService } from '../../lib/plan/planService';
import type { TargetDeviceSnapshot, MeasuredPowerObservedProbe } from '../../packages/contracts/src/types';
import { partialDouble } from '../helpers/partialDouble';
import { AppSnapshotHelpers } from '../../setup/appSnapshotHelpers';
import { disableUnsupportedDevices } from '../../setup/appDeviceSupport';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { mockHomeyInstance } from '../mocks/homey';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { PowerSampleAdmission } from '../../lib/app/appContext';

const mockPowerSource = () => normalizePowerSource(mockHomeyInstance.settings.get('power_source'));

// Automatic is these fixtures' whole-home meter posture. Stated once here and
// passed in, because the helper takes the selection as a required dep: there is
// no in-class default that could quietly stand in for an unread selection.
const mainMeterSelection = (): MainMeterSelection => ({ state: 'resolved', meterDeviceId: 'm-area' });

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
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot: vi.fn() }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => false),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });

    helper.startPeriodicSnapshotRefresh();
    const initialTimerCount = vi.getTimerCount();
    expect(initialTimerCount).toBeGreaterThan(0);

    helper.startPeriodicSnapshotRefresh();
    expect(vi.getTimerCount()).toBe(initialTimerCount);

    helper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles overlapping target-power probes at each independent deadline', async () => {
    vi.setSystemTime(new Date(0));
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => undefined,
      getPlanEngine: () => undefined,
      getPlanService: () => undefined,
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date(Date.now()),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });
    const refresh = vi.spyOn(helper, 'refreshTargetDevicesSnapshot').mockResolvedValue(undefined);
    helper.startPeriodicSnapshotRefresh();

    helper.scheduleTargetPowerProbeSettlement(100);
    helper.scheduleTargetPowerProbeSettlement(200);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
    helper.stop();
  });

  it('rebuilds in the background when a persisted target-power retry becomes due', async () => {
    vi.setSystemTime(new Date(0));
    const rebuildOwningHomePlanForDevice = vi.fn().mockResolvedValue(undefined);
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => undefined,
      getPlanEngine: () => undefined,
      getPlanService: () => undefined,
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date(Date.now()),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
      getNextTargetPowerProbe: () => ({ deviceId: 'sub-home-charger', dueAtMs: 100 }),
      rebuildOwningHomePlanForDevice,
    });
    helper.startPeriodicSnapshotRefresh();

    await vi.advanceTimersByTimeAsync(100);

    expect(rebuildOwningHomePlanForDevice).toHaveBeenCalledWith(
      'sub-home-charger',
      'target_power_probe_due',
    );
    helper.stop();
  });

  it('does not restart target-power settlement timers after stop during refresh', async () => {
    vi.setSystemTime(new Date(0));
    let finishRefresh: (() => void) | undefined;
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => undefined,
      getPlanEngine: () => undefined,
      getPlanService: () => undefined,
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date(Date.now()),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });
    const refresh = vi.spyOn(helper, 'refreshTargetDevicesSnapshot').mockImplementation(() => (
      new Promise<void>((resolve) => { finishRefresh = resolve; })
    ));
    helper.startPeriodicSnapshotRefresh();
    helper.scheduleTargetPowerProbeSettlement(100);
    helper.scheduleTargetPowerProbeSettlement(200);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    helper.stop();
    finishRefresh?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tags headroom syncs from snapshot refresh with snapshot_refresh reconciliation context', async () => {
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const syncLivePlanState = vi.fn(async () => false);
    const syncHeadroomCardState = vi.fn();
    const snapshot: (TargetDeviceSnapshot & MeasuredPowerObservedProbe)[] = [{
      id: 'dev-1',
      name: 'Heater',
      targets: [],
      available: true,
      expectedPowerSource: 'default',
      binaryControl: { on: true },
      expectedPowerKw: 1.2,
      measuredPowerKw: 1.2,
    }];
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState,
        syncHeadroomCardState,
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => snapshot,
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });
    const scheduleTargetPowerProbe = vi.spyOn(helper, 'scheduleTargetPowerProbe');

    await helper['runSnapshotRefreshCycle'](partialDouble<DeviceTransport>({ refreshSnapshot }), { targeted: true });

    expect(scheduleTargetPowerProbe).toHaveBeenCalledTimes(1);
    expect(syncHeadroomCardState).toHaveBeenCalledWith({
      devices: [{
        ...snapshot[0],
        managed: true,
        controllable: true,
        currentOn: true,
        // Stamped by `withHeadroomCurrentOn`, the producer boundary for devices
        // that reach the usage math straight off the transport.
        currentDrawKw: 1.2,
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
      return false;
    });
    const syncHeadroomCardState = vi.fn((_params?: unknown) => {
      callOrder.push('syncHeadroomCardState');
    }) as unknown as PlanService['syncHeadroomCardState'] & ReturnType<typeof vi.fn>;
    const disableUnsupported = vi.fn(() => {
      callOrder.push('disableUnsupportedDevices');
    });
    const emitSettingsUiDevicesUpdated = vi.fn(() => {
      callOrder.push('emitSettingsUiDevicesUpdated');
    });
    const snapshot: TargetDeviceSnapshot[] = [{
      id: 'dev-1',
      name: 'Unsupported Socket',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
      available: true,
      expectedPowerKw: 0,
      expectedPowerSource: 'default',
    }];
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState,
        syncHeadroomCardState,
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => snapshot,
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: disableUnsupported,
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated,
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });

    await helper['runSnapshotRefreshCycle'](partialDouble<DeviceTransport>({ refreshSnapshot }), { targeted: true });

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
    const snapshot: TargetDeviceSnapshot[] = [{
      id: 'socket-1',
      name: 'Unsupported Socket',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
      available: true,
      expectedPowerKw: 0,
      expectedPowerSource: 'default',
      managed: true,
      controllable: true,
    }];
    const syncHeadroomCardState = vi.fn(() => {
      settingsSeenByHeadroom.push(mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES));
    }) as unknown as PlanService['syncHeadroomCardState'] & ReturnType<typeof vi.fn>;
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => {
          settingsSeenByLivePlan.push(mockHomeyInstance.settings.get(MANAGED_DEVICES));
          return false;
        }),
        syncHeadroomCardState,
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => snapshot,
      resolveManagedState: (deviceId) => (
        mockHomeyInstance.settings.get(MANAGED_DEVICES) as Record<string, boolean>
      )[deviceId] !== false,
      isCapacityControlEnabled: (deviceId) => (
        mockHomeyInstance.settings.get(CONTROLLABLE_DEVICES) as Record<string, boolean>
      )[deviceId] !== false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: (nextSnapshot) => disableUnsupportedDevices({
        snapshot: nextSnapshot,
        settings: mockHomeyInstance.settings as unknown as Homey.App['homey']['settings'],
        debugStructured: vi.fn(),
      }),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });

    await helper['runSnapshotRefreshCycle'](partialDouble<DeviceTransport>({ refreshSnapshot }), { targeted: true });

    expect(settingsSeenByLivePlan).toEqual([{ 'socket-1': false }]);
    expect(settingsSeenByHeadroom).toEqual([{ 'socket-1': false }]);
    expect(syncHeadroomCardState).toHaveBeenCalledWith({
      devices: [{
        ...snapshot[0],
        managed: false,
        controllable: false,
        // The producer answers for an unmetered device too. This fixture declares
        // no load either, so there is genuinely nothing to draw against.
        currentDrawKw: 0,
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
    const snapshot: TargetDeviceSnapshot[] = [{
      id: 'socket-1',
      name: 'Unsupported Socket',
      deviceType: 'onoff',
      powerCapable: false,
      targets: [],
      available: true,
      expectedPowerKw: 0,
      expectedPowerSource: 'default',
    }];
    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => false),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => snapshot,
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: (nextSnapshot) => disableUnsupportedDevices({
        snapshot: nextSnapshot,
        settings: mockHomeyInstance.settings as unknown as Homey.App['homey']['settings'],
        debugStructured: vi.fn(),
      }),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });

    await helper['runSnapshotRefreshCycle'](partialDouble<DeviceTransport>({ refreshSnapshot }), { targeted: true });

    // No write to MANAGED_DEVICES means the settings handler is never fired,
    // so no recursive snapshot refresh is queued.
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(MANAGED_DEVICES);
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(CONTROLLABLE_DEVICES);
  });

  it('emits flow-backed refresh requests only once across queued snapshot cycles', async () => {
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const helperRef: { current?: AppSnapshotHelpers } = {};
    const emitFlowBackedRefreshRequests = vi.fn(async () => {
      await helperRef.current?.refreshTargetDevicesSnapshot({ emitFlowBackedRefresh: false });
    });

    const helper = new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => false),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => ['dev-1']),
      emitFlowBackedRefreshRequests,
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });
    helperRef.current = helper;
    helper['snapshotRefreshStopped'] = false;

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
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => false),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });
    helper['snapshotRefreshStopped'] = false;

    const firstRefresh = helper.refreshTargetDevicesSnapshot();
    await Promise.resolve();
    // Overlapping callers await the in-flight refresh now, so do
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
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => false),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
      resolveMainMeterSelection: mainMeterSelection,
    });
    helper['snapshotRefreshStopped'] = false;

    const firstRefresh = helper.refreshTargetDevicesSnapshot();
    await Promise.resolve();
    const secondRefresh = helper.refreshTargetDevicesSnapshot();
    let secondSettled = false;
    void secondRefresh.then(() => { secondSettled = true; });
    // The second call must not resolve before the in-flight cycle (still
    // gated on `deferred`) completes — that is the contract here:
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

  // The identity of the sampled whole-home meter says where the tracker's watts
  // came from. It therefore rides the SAME admission as the sample: a refresh
  // that reads live power but discards the sample must not publish one.
  //
  // The post-actuation refresh is the reachable case. `schedulePostActuationRefresh`
  // is wired from `createPlanService`, which BOTH the main home and every
  // sub-home capacity bundle use, all pointing at these shared helpers — so a
  // meter AREA's actuation schedules a refresh that reads Main's meters. It
  // passes `recordHomeyEnergySample: false` (and no `fast`), so it reads live
  // power and throws the sample away. Publishing identity there would republish
  // Main's meter while the tracker still holds the area's watts, reopening the
  // ownership fence over a sample that never changed.
  // The meter identity RIDES the sample: `recordPowerSample` receives one
  // object carrying both, and the pipeline publishes the identity atomically
  // with the ingest. So the admission proof at this seam is simply whether the
  // identity-carrying sample reaches `recordPowerSample` at all — there is no
  // second decision that could diverge from it. The post-actuation refresh
  // (scheduled through these shared helpers by ANY home's actuation, including
  // a meter area's) is the canonical discarded-sample caller.
  describe('implicit sample admission carries the meter identity', () => {
    const buildHelper = (
      refreshSnapshot: ReturnType<typeof vi.fn>,
      recordPowerSample: ReturnType<typeof vi.fn>,
      resolveMainMeterSelection: () => MainMeterSelection = mainMeterSelection,
    ) => new AppSnapshotHelpers({
      getPowerSource: mockPowerSource,
      timers: new TimerRegistry(),
      getDeviceManager: () => partialDouble<DeviceTransport>({ refreshSnapshot: refreshSnapshot as DeviceTransport['refreshSnapshot'] }),
      getPlanEngine: () => undefined,
      getPlanService: () => partialDouble<PlanService>({
        syncLivePlanState: vi.fn(async () => false),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      }),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn(),
      getNow: () => new Date(),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      persistFilledModeTargets: vi.fn(),
      getFlowReportedDeviceIds: vi.fn(() => []),
      emitFlowBackedRefreshRequests: vi.fn().mockResolvedValue(undefined),
      emitSettingsUiDevicesUpdated: vi.fn(),
      recordPowerSample: recordPowerSample as (sample: { powerW: number }) => Promise<PowerSampleAdmission>,
      resolveMainMeterSelection,
    });

    const AREA_SAMPLE = { powerW: 4_200, meterDeviceId: 'm-area' };

    const runRefresh = async (
      options: Parameters<AppSnapshotHelpers['refreshTargetDevicesSnapshot']>[0],
      resolveSelection: () => MainMeterSelection = mainMeterSelection,
      pipelineAdmission: PowerSampleAdmission = { state: 'admitted', revision: 1 },
    ) => {
      const refreshSnapshot = vi.fn().mockResolvedValue(AREA_SAMPLE);
      const recordPowerSample = vi.fn().mockResolvedValue(pipelineAdmission);
      const helper = buildHelper(
        refreshSnapshot,
        recordPowerSample,
        resolveSelection,
      );
      await helper.refreshTargetDevicesSnapshot(options);
      expect(refreshSnapshot).toHaveBeenCalled();
      return { recordPowerSample, refreshSnapshot };
    };

    // The reason the selection is a required dep and not an optional with an
    // Automatic default: `unavailable` has to survive the trip to the fetch.
    // Defaulted, this cycle would read and record the Automatic meter's watts
    // for a home whose selection nobody could read.
    it('an unreadable selection reaches the fetch as unavailable and records nothing', async () => {
      mockHomeyInstance.settings.set('power_source', 'homey_energy');
      const { recordPowerSample, refreshSnapshot } = await runRefresh(
        {},
        () => ({ state: 'unavailable' }),
      );
      expect(refreshSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ mainMeterSelection: { state: 'unavailable' } }),
      );
      expect(recordPowerSample).not.toHaveBeenCalled();
    });

    it('an ordinary refresh records the identity-carrying sample', async () => {
      mockHomeyInstance.settings.set('power_source', 'homey_energy');
      const { recordPowerSample } = await runRefresh({});
      expect(recordPowerSample).toHaveBeenCalledTimes(1);
      // The identity arrives ON the recorded sample — the pipeline publishes it
      // from exactly this object, so sample and identity cannot diverge.
      expect(recordPowerSample).toHaveBeenCalledWith(AREA_SAMPLE);
    });

    it('the post-actuation refresh records nothing, so its identity claim dies with the sample', async () => {
      mockHomeyInstance.settings.set('power_source', 'homey_energy');
      const { recordPowerSample } = await runRefresh({
        targeted: true,
        recordHomeyEnergySample: false,
      });
      expect(recordPowerSample).not.toHaveBeenCalled();
    });

    it('flow mode records nothing', async () => {
      mockHomeyInstance.settings.set('power_source', 'flow');
      const { recordPowerSample } = await runRefresh({});
      expect(recordPowerSample).not.toHaveBeenCalled();
    });

    it('a mid-flight meter selection change records nothing', async () => {
      mockHomeyInstance.settings.set('power_source', 'homey_energy');
      let call = 0;
      const { recordPowerSample } = await runRefresh({}, () => {
        call += 1;
        return { state: 'resolved', meterDeviceId: call === 1 ? 'm-old' : 'm-new' };
      });
      expect(recordPowerSample).not.toHaveBeenCalled();
    });

    it('a superseded snapshot still hands the pipeline its sample — coalescing owns the drop', async () => {
      mockHomeyInstance.settings.set('power_source', 'homey_energy');
      const { recordPowerSample } = await runRefresh(
        {},
        mainMeterSelection,
        { state: 'superseded', revision: 1, latestRevision: 2 },
      );
      expect(recordPowerSample).toHaveBeenCalledWith(AREA_SAMPLE);
    });

    it('an unreadable power source surfaces as a failed refresh, recording nothing', async () => {
      // `getPowerSource()` throws on a suspect settings read. There is only ONE
      // admission evaluation now, so the throw has exactly one behaviour: the
      // refresh fails visibly, and neither the sample nor its identity land.
      const refreshSnapshot = vi.fn().mockResolvedValue(AREA_SAMPLE);
      const recordPowerSample = vi.fn().mockResolvedValue({ state: 'admitted', revision: 1 });
      const helper = buildHelper(refreshSnapshot, recordPowerSample);
      helper['deps'].getPowerSource = () => {
        throw new Error('settings unavailable');
      };

      await expect(helper.refreshTargetDevicesSnapshot({})).rejects.toThrow('settings unavailable');
      expect(recordPowerSample).not.toHaveBeenCalled();
    });
  });
});
