import { createApp, cleanupApps } from './utils/appTestUtils';
import { setRestClient, resetRestClient } from '../lib/device/transport/managerHomeyApi';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

// Drives PelsApp.applyNativeWiringAutoDecisions end-to-end: real flow read
// (via the REST-client seam) + real detection, with the app's snapshot /
// plan collaborators stubbed so we can observe the apply orchestration.

const hoiaxCandidate = (id: string): TargetDeviceSnapshot => ({
  id,
  name: id,
  nativeWriteCapabilities: ['max_power_3000', 'onoff'],
} as unknown as TargetDeviceSnapshot);

describe('applyNativeWiringAutoDecisions', () => {
  afterEach(async () => {
    resetRestClient();
    await cleanupApps();
    vi.restoreAllMocks();
  });

  const stubApp = (snapshot: TargetDeviceSnapshot[]) => {
    const app = createApp();
    const refreshTargetDevicesSnapshot = vi.fn().mockResolvedValue(undefined);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    (app as any).snapshotWarmupGate = { wait: async () => {} };
    (app as any).deviceManager = { getSnapshot: () => snapshot };
    (app as any).snapshotHelpers = { refreshTargetDevicesSnapshot };
    (app as any).planService = { rebuildPlanFromCache };
    return { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache };
  };

  it('auto-enables a conflict-free Hoiax device and rebuilds once', async () => {
    // Empty flow lists → no conflicts.
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);

    await (app as any).applyNativeWiringAutoDecisions();

    expect((app as any).autoNativeWiringDecisions).toEqual({ 'hoiax-1': true });
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('native_wiring_auto_decision');

    // Second run with the same decision set must not refresh/rebuild again.
    await (app as any).applyNativeWiringAutoDecisions();
    expect(refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('skips a concurrent run while one is in flight (no overlapping reads)', async () => {
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    let getCalls = 0;
    setRestClient({
      get: async () => { getCalls += 1; await gate; return {}; },
      put: vi.fn(),
    });
    const { app } = stubApp([hoiaxCandidate('hoiax-1')]);

    const first = (app as any).applyNativeWiringAutoDecisions();
    await Promise.resolve(); // let the first run begin its (gated) reads
    const callsDuringFirst = getCalls;

    // A concurrent call while the first is in flight must early-return without
    // starting its own detection reads.
    await (app as any).applyNativeWiringAutoDecisions();
    expect(getCalls).toBe(callsDuringFirst);

    releaseGet();
    await first;
  });

  it('drops the apply when uninit begins while the flow read is in flight', async () => {
    // The probe is fire-and-forget: a read can still be parked when the app
    // tears down. onUninit flips the flag; the continuation must not refresh
    // the snapshot or rebuild the plan against a half-torn-down app.
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    setRestClient({ get: async () => { await gate; return {}; }, put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);

    const run = (app as any).applyNativeWiringAutoDecisions();
    await Promise.resolve(); // park the run on the gated read

    // Simulate onUninit racing the in-flight read.
    (app as any).nativeWiringUninitializing = true;
    releaseGet();
    await run;

    expect((app as any).autoNativeWiringDecisions).toEqual({});
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('keeps existing decisions when a re-query snapshot is empty (transient hiccup)', async () => {
    // A periodic re-query whose snapshot is transiently empty must not clear a
    // prior auto decision — an empty snapshot resolves to unknown (no-op), not
    // an empty "ok" verdict that would turn native control off for a tick.
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([]);
    (app as any).autoNativeWiringDecisions = { 'hoiax-1': true };
    (app as any).delayMs = vi.fn().mockResolvedValue(undefined); // skip retry waits

    await (app as any).applyNativeWiringAutoDecisions();

    expect((app as any).autoNativeWiringDecisions).toEqual({ 'hoiax-1': true });
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('rolls back the decision when the refresh/rebuild fails (atomic apply)', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const { app, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);
    (app as any).snapshotHelpers = {
      refreshTargetDevicesSnapshot: vi.fn().mockRejectedValue(new Error('refresh boom')),
    };

    await expect((app as any).applyNativeWiringAutoDecisions()).rejects.toThrow('refresh boom');

    // Decision rolled back so a later re-query is not short-circuited.
    expect((app as any).autoNativeWiringDecisions).toEqual({});
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('retries detection when the snapshot is still empty (warm-up timeout), then enables', async () => {
    setRestClient({ get: async () => ({}), put: vi.fn() });
    const app = createApp();
    const refreshTargetDevicesSnapshot = vi.fn().mockResolvedValue(undefined);
    const rebuildPlanFromCache = vi.fn().mockResolvedValue(undefined);
    // Empty on the first check (gate released before the snapshot warmed),
    // populated on the retry.
    let call = 0;
    (app as any).snapshotWarmupGate = { wait: async () => {} };
    (app as any).deviceManager = {
      getSnapshot: () => (++call === 1 ? [] : [hoiaxCandidate('hoiax-1')]),
    };
    (app as any).snapshotHelpers = { refreshTargetDevicesSnapshot };
    (app as any).planService = { rebuildPlanFromCache };
    (app as any).delayMs = vi.fn().mockResolvedValue(undefined); // skip the real wait

    await (app as any).applyNativeWiringAutoDecisions();

    expect((app as any).delayMs).toHaveBeenCalled();
    expect((app as any).autoNativeWiringDecisions).toEqual({ 'hoiax-1': true });
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('native_wiring_auto_decision');
  });

  it('does not enable or rebuild when the flow read fails closed', async () => {
    setRestClient({ get: async () => { throw new Error('403 Forbidden'); }, put: vi.fn() });
    const { app, refreshTargetDevicesSnapshot, rebuildPlanFromCache } = stubApp([hoiaxCandidate('hoiax-1')]);

    await (app as any).applyNativeWiringAutoDecisions();

    expect((app as any).autoNativeWiringDecisions).toEqual({});
    expect(refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});
