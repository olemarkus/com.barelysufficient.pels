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
