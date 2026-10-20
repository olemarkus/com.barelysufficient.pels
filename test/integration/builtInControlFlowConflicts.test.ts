import type MyApp from '../../app.ts';
import { partialDouble } from '../helpers/partialDouble';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { ADVANCED_FLOW_API_PATH } from '../../lib/flowApi/readUserFlows';
import { mockHomeyInstance } from '../mocks/homey';
import { NATIVE_EV_WIRING_DEVICES } from '../../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

// Drives BuiltInControlFlowConflicts end-to-end: real flow read
// (via the REST-client seam) + real detection, with the app's snapshot /
// plan collaborators stubbed so we can observe the apply orchestration.

const hoiaxCandidate = (id: string): TargetDeviceSnapshot => ({
  id,
  name: id,
  nativeWriteCapabilities: ['max_power_3000', 'onoff'],
} as unknown as TargetDeviceSnapshot);

describe('BuiltInControlFlowConflicts', () => {
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
  });

  const stubApp = (snapshot: TargetDeviceSnapshot[]) => {
    const app = createApp();
    const refreshTargetDevicesSnapshot = vi.fn().mockResolvedValue(undefined);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ failed: false });
    app.snapshotWarmupGate = partialDouble<NonNullable<MyApp['snapshotWarmupGate']>>({ wait: async () => {} });
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => snapshot,
      chargingCurrentControl: partialDouble<MyApp['deviceManager']['chargingCurrentControl']>({
        acceptFlowFacts: () => false,
        acceptedFlowWrites: new Map(),
        restoreFlowWrites: () => {},
      }),
    });
    (app as unknown as { snapshotHelpers: unknown }).snapshotHelpers = { refreshTargetDevicesSnapshot };
    app.planService = partialDouble<MyApp['planService']>({ rebuildPlanFromCache });
    return { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache };
  };

  it('auto-enables a conflict-free Hoiax device and rebuilds once', async () => {
    // Empty flow lists → no conflicts.
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);

    await app['builtInControlFlowConflicts'].applyBackgroundScan();

    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({ 'hoiax-1': true });
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('native_wiring_auto_decision');

    // Second run with the same decision set must not refresh/rebuild again.
    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('holds an explicit choice back when a conflicting Flow appears, and re-parses each time', async () => {
    const easee = {
      id: 'easee-1',
      name: 'Easee',
      nativeWriteCapabilities: ['target_charger_current', 'setDynamicChargerCurrent'],
    } as unknown as TargetDeviceSnapshot;
    let flowWrites = true;
    setRestClient({
      get: async (path) => (path === ADVANCED_FLOW_API_PATH && flowWrites
        ? { bev: { name: 'PELS BEV', cards: { set: { type: 'action', id: 'homey:device:easee-1:setDynamicChargerCurrent' } } } }
        : {}),
      put: vi.fn(),
    });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([easee]);
    mockHomeyInstance.settings.set(NATIVE_EV_WIRING_DEVICES, { 'easee-1': true });
    app.deviceControlSettings.reload();
    const resolve = () => app['builtInControlFlowConflicts'].resolveNativeWiringEnabled('easee-1');

    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(resolve()).toBe(false);
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('native_wiring_auto_decision');

    flowWrites = false;
    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(resolve()).toBe(true);
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(2);
  });

  it('re-projects when only a charging-current route changes, and restores it when the refresh fails', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([]);
    const accepted = new Map([['tesla', new Map()]]);
    const acceptFlowFacts = vi.fn(() => true);
    const restoreFlowWrites = vi.fn();
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => [hoiaxCandidate('hoiax-1')],
      chargingCurrentControl: partialDouble<MyApp['deviceManager']['chargingCurrentControl']>({
        acceptFlowFacts, acceptedFlowWrites: accepted, restoreFlowWrites,
      }),
    });
    app['builtInControlFlowConflicts']['autoDecisions'] = { 'hoiax-1': true };

    // The native maps are unchanged; the charging route change alone re-projects.
    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(acceptFlowFacts).toHaveBeenCalledTimes(1);
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('native_wiring_auto_decision');
    expect(restoreFlowWrites).not.toHaveBeenCalled();

    refreshTargetDevicesSnapshot.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(app.refreshFlowConflictsForUi()).rejects.toThrow('refresh failed');
    // The list in effect before this scan, not one a later read accepted.
    expect(restoreFlowWrites).toHaveBeenCalledExactlyOnceWith(accepted);
    // Nothing was projected for the failed list, so nothing is re-projected.
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(2);
  });

  it('re-projects the restored routes when the rebuild fails after the snapshot took the new ones', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);
    const restoreFlowWrites = vi.fn();
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => [hoiaxCandidate('hoiax-1')],
      chargingCurrentControl: partialDouble<MyApp['deviceManager']['chargingCurrentControl']>({
        acceptFlowFacts: () => true, acceptedFlowWrites: new Map(), restoreFlowWrites,
      }),
    });
    rebuildPlanFromCache.mockResolvedValueOnce({ failed: true });

    await expect(app.refreshFlowConflictsForUi()).rejects.toThrow('Plan rebuild failed');
    expect(restoreFlowWrites).toHaveBeenCalledTimes(1);
    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({});
    // Once for the new routes, once more for the restored ones.
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(2);
  });

  const chargingDouble = (
    order: string[],
    readFlows: () => Promise<{ status: 'ok'; facts: { writes: Map<string, never>; evSocReporters: [] } }
      | { status: 'unknown'; reason: string }>,
    routesMove: () => boolean,
  ) => partialDouble<MyApp['deviceManager']['chargingCurrentControl']>({
    acceptFlowFacts: () => { order.push('accept'); return routesMove(); },
    acceptedFlowWrites: new Map(),
    restoreFlowWrites: () => { order.push('restore'); },
    readFlows: async () => { order.push('read'); return readFlows(); },
    describe: (flows) => { order.push(`describe:${flows.status}`); return []; },
  });
  const clearFacts = { writes: new Map<string, never>(), evSocReporters: [] as [] };

  it('reads and applies the charging page Flow list after a running scan, so it never lands over a newer one', async () => {
    let releaseScan: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let getCalls = 0;
    setRestClient({ get: async () => { getCalls += 1; if (getCalls <= 2) await scanGate; return {}; }, put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot } = stubApp([hoiaxCandidate('hoiax-1')]);
    const order: string[] = [];
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => [hoiaxCandidate('hoiax-1')],
      chargingCurrentControl: chargingDouble(order, async () => ({ status: 'ok', facts: clearFacts }),
        () => order.filter((step) => step === 'accept').length === 2),
    });

    const scan = app['builtInControlFlowConflicts'].applyBackgroundScan();
    await vi.waitFor(() => { expect(getCalls).toBe(2); });
    const read = app['builtInControlFlowConflicts'].readChargingCurrent();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    // Queued behind the scan: the page has not even read its Flow list yet.
    expect(order).toEqual([]);

    releaseScan();
    await scan;
    await expect(read).resolves.toEqual([]);
    // The scan accepts first; the page reads after it, and its route move re-projects before it reports.
    expect(order).toEqual(['accept', 'read', 'accept', 'describe:ok']);
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(2);
  });

  it('reports the route last accepted, and applies nothing, when the page cannot read the Flows', async () => {
    const { app, refreshTargetDevicesSnapshot } = stubApp([hoiaxCandidate('hoiax-1')]);
    const order: string[] = [];
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => [hoiaxCandidate('hoiax-1')],
      chargingCurrentControl: chargingDouble(order, async () => ({ status: 'unknown', reason: '403' }), () => true),
    });

    await expect(app['builtInControlFlowConflicts'].readChargingCurrent()).resolves.toEqual([]);
    expect(order).toEqual(['read', 'describe:unknown']);
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
  });

  it('reports the rolled-back route when applying the page read fails', async () => {
    const { app, refreshTargetDevicesSnapshot } = stubApp([hoiaxCandidate('hoiax-1')]);
    refreshTargetDevicesSnapshot.mockRejectedValueOnce(new Error('refresh failed'));
    const order: string[] = [];
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => [hoiaxCandidate('hoiax-1')],
      chargingCurrentControl: chargingDouble(order, async () => ({ status: 'ok', facts: clearFacts }), () => true),
    });

    // The page still loads; the failed list was put back before it describes the route.
    await expect(app['builtInControlFlowConflicts'].readChargingCurrent()).resolves.toEqual([]);
    expect(order).toEqual(['read', 'accept', 'restore', 'describe:ok']);
  });

  it('rolls back when the plan rebuild reports failure', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);
    rebuildPlanFromCache.mockResolvedValueOnce({ failed: true });

    await expect(app.refreshFlowConflictsForUi()).rejects.toThrow('Plan rebuild failed');
    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({});
  });

  it('saves every accepted scan, an unchanged one too, so a failed save heals', async () => {
    setRestClient({
      get: async (path) => (path === ADVANCED_FLOW_API_PATH
        ? { bev: { name: 'PELS BEV', cards: { set: { type: 'action', id: 'homey:device:easee-1:setDynamicChargerCurrent' } } } }
        : {}),
      put: vi.fn(),
    });
    const easee = {
      id: 'easee-1', name: 'Easee', nativeWriteCapabilities: ['target_charger_current', 'setDynamicChargerCurrent'],
    } as unknown as TargetDeviceSnapshot;
    const { app, refreshTargetDevicesSnapshot } = stubApp([easee]);
    const accept = vi.spyOn(app['builtInControlFlowConflicts']['conflicts'], 'accept');
    const conflicts = { 'easee-1': { conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'PELS BEV' } };

    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(accept).toHaveBeenLastCalledWith(conflicts);
    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenLastCalledWith(conflicts);
  });

  it('drops a concurrent background run while one is in flight', async () => {
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    let getCalls = 0;
    setRestClient({
      get: async () => { getCalls += 1; await gate; return {}; },
      put: vi.fn(),
    });
    const { app } = stubApp([hoiaxCandidate('hoiax-1')]);

    const first = app['builtInControlFlowConflicts'].applyBackgroundScan();
    await vi.waitFor(() => { expect(getCalls).toBe(2); });
    const callsDuringFirst = getCalls;

    // Background refreshes are best-effort: another periodic request adds no
    // information and must not queue a second expensive Flow read.
    await app['builtInControlFlowConflicts'].applyBackgroundScan();
    expect(getCalls).toBe(callsDuringFirst);

    releaseGet();
    await first;
  });

  it('queues an explicit check behind an older scan and reads the fixed Flow state', async () => {
    let releaseFirstScan: () => void = () => {};
    const firstScanGate = new Promise<void>((resolve) => { releaseFirstScan = resolve; });
    let getCalls = 0;
    setRestClient({
      get: async (path) => {
        const scanIndex = Math.floor(getCalls / 2);
        getCalls += 1;
        if (scanIndex === 0) {
          await firstScanGate;
          return path === 'manager/flow/flow/' ? {
            conflicting: {
              name: 'Old bridge',
              actions: [{ id: 'homey:device:hoiax-1:max_power_3000' }],
            },
          } : {};
        }
        return {};
      },
      put: vi.fn(),
    });
    const { app } = stubApp([hoiaxCandidate('hoiax-1')]);

    const background = app['builtInControlFlowConflicts'].applyBackgroundScan();
    await vi.waitFor(() => { expect(getCalls).toBe(2); });
    const explicit = app.refreshFlowConflictsForUi();
    expect(getCalls).toBe(2);

    releaseFirstScan();
    await background;
    await expect(explicit).resolves.toEqual({
      state: 'resolved',
      flowFacts: { writes: new Map(), evSocReporters: [] },
    });
    expect(getCalls).toBe(4);
    expect(app['builtInControlFlowConflicts']['conflicts'].all).toEqual({});
    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({ 'hoiax-1': true });
  });

  it('drops the apply when uninit begins while the flow read is in flight', async () => {
    // The probe is fire-and-forget: a read can still be parked when the app
    // tears down. onUninit flips the flag; the continuation must not refresh
    // the snapshot or rebuild the plan against a half-torn-down app.
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    let getCalls = 0;
    setRestClient({ get: async () => { getCalls += 1; await gate; return {}; }, put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);

    const run = app['builtInControlFlowConflicts'].applyBackgroundScan();
    await vi.waitFor(() => { expect(getCalls).toBe(2); });

    // Simulate onUninit racing the in-flight read.
    app['shutdown'].stop();
    releaseGet();
    await run;

    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({});
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('keeps existing decisions when a re-query snapshot is empty (transient hiccup)', async () => {
    // A periodic re-query whose snapshot is transiently empty must not clear a
    // prior auto decision — an empty snapshot resolves to unknown (no-op), not
    // an empty "ok" verdict that would turn native control off for a tick.
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([]);
    app['builtInControlFlowConflicts']['autoDecisions'] = { 'hoiax-1': true };
    vi.spyOn(app['builtInControlFlowConflicts'], 'delayMs').mockResolvedValue(undefined); // skip retry waits

    await app['builtInControlFlowConflicts'].applyBackgroundScan();

    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({ 'hoiax-1': true });
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rolls back the decision when the refresh/rebuild fails (atomic apply)', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);
    (app as unknown as { snapshotHelpers: unknown }).snapshotHelpers = {
      refreshTargetDevicesSnapshot: vi.fn().mockRejectedValue(new Error('refresh boom')),
    };

    await expect(app['builtInControlFlowConflicts'].applyBackgroundScan()).rejects.toThrow('refresh boom');

    // Decision rolled back so a later re-query is not short-circuited.
    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({});
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('retries detection when the snapshot is still empty (warm-up timeout), then enables', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const app = createApp();
    const refreshTargetDevicesSnapshot = vi.fn().mockResolvedValue(undefined);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue({ failed: false });
    // Empty on the first check (gate released before the snapshot warmed),
    // populated on the retry.
    let call = 0;
    app.snapshotWarmupGate = partialDouble<NonNullable<MyApp['snapshotWarmupGate']>>({ wait: async () => {} });
    app.deviceManager = partialDouble<MyApp['deviceManager']>({
      getSnapshot: () => (++call === 1 ? [] : [hoiaxCandidate('hoiax-1')]),
      chargingCurrentControl: partialDouble<MyApp['deviceManager']['chargingCurrentControl']>({
        acceptFlowFacts: () => false,
        acceptedFlowWrites: new Map(),
        restoreFlowWrites: () => {},
      }),
    });
    (app as unknown as { snapshotHelpers: unknown }).snapshotHelpers = { refreshTargetDevicesSnapshot };
    app.planService = partialDouble<MyApp['planService']>({ rebuildPlanFromCache });
    const delayMs = vi.spyOn(app['builtInControlFlowConflicts'], 'delayMs').mockResolvedValue(undefined);

    await app['builtInControlFlowConflicts'].applyBackgroundScan();

    expect(delayMs).toHaveBeenCalled();
    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({ 'hoiax-1': true });
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('native_wiring_auto_decision');
  });

  it('does not enable or rebuild when the flow read fails closed', async () => {
    setRestClient({ get: async () => { throw new Error('403 Forbidden'); }, put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);

    await app['builtInControlFlowConflicts'].applyBackgroundScan();

    expect(app['builtInControlFlowConflicts']['autoDecisions']).toEqual({});
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('reports an explicit check as unavailable when the flow read fails closed', async () => {
    setRestClient({ get: async () => { throw new Error('403 Forbidden'); }, put: vi.fn() });
    const { app } = stubApp([hoiaxCandidate('hoiax-1')]);

    await expect(app.refreshFlowConflictsForUi()).resolves.toEqual({ state: 'unavailable' });
  });
});
