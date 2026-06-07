import { SnapshotWarmupGate } from '../../lib/plan/snapshotWarmupGate';
import { startAppServices } from '../../setup/appLifecycleHelpers';
import { TimerRegistry } from '../../lib/app/timerRegistry';
import { createAppContextMock } from '../helpers/appContextTestHelpers';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolveRef: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectRef: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });
  return { promise, resolve: resolveRef, reject: rejectRef };
};

const flushMicrotasks = async (iterations = 16): Promise<void> => {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
};

describe('SnapshotWarmupGate', () => {
  it('starts unreleased and exposes a pending wait()', async () => {
    const gate = new SnapshotWarmupGate({ timeoutMs: 60_000 });
    expect(gate.isReleased()).toBe(false);
    expect(gate.getReleaseReason()).toBeNull();

    let settled = false;
    void gate.wait().then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    gate.release('snapshot_ready');
    await flushMicrotasks();
    expect(settled).toBe(true);
    expect(gate.isReleased()).toBe(true);
    expect(gate.getReleaseReason()).toBe('snapshot_ready');
  });

  it('auto-releases after the bounded timeout via the injected setTimeout', async () => {
    let scheduledMs: number | undefined;
    let scheduledCallback: (() => void) | undefined;
    const gate = new SnapshotWarmupGate({
      timeoutMs: 5_000,
      setTimeoutFn: (callback, delayMs) => {
        scheduledMs = delayMs;
        scheduledCallback = callback;
        return 'token' as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: vi.fn(),
    });
    expect(scheduledMs).toBe(5_000);
    expect(gate.isReleased()).toBe(false);

    scheduledCallback?.();
    expect(gate.isReleased()).toBe(true);
    expect(gate.getReleaseReason()).toBe('timeout');
  });

  it('releases immediately when timeoutMs is 0 (test mode)', async () => {
    const onRelease = vi.fn();
    const gate = new SnapshotWarmupGate({ timeoutMs: 0, onRelease });
    expect(gate.isReleased()).toBe(true);
    expect(gate.getReleaseReason()).toBe('timeout');
    expect(onRelease).toHaveBeenCalledWith('timeout');
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it('ignores subsequent release() calls (first reason wins)', () => {
    const onRelease = vi.fn();
    const gate = new SnapshotWarmupGate({ timeoutMs: 60_000, onRelease });
    gate.release('snapshot_ready');
    gate.release('timeout');
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith('snapshot_ready');
    expect(gate.getReleaseReason()).toBe('snapshot_ready');
  });

  it('cancels the timeout timer when released early via snapshot_ready', () => {
    const clearTimeoutFn = vi.fn();
    const gate = new SnapshotWarmupGate({
      timeoutMs: 5_000,
      setTimeoutFn: () => 'token' as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn,
    });
    gate.release('snapshot_ready');
    expect(clearTimeoutFn).toHaveBeenCalledWith('token');
  });
});

const buildBootstrapContext = () => {
  const timers = new TimerRegistry();
  const ctx = createAppContextMock({ timers });
  const warmupGate = new SnapshotWarmupGate({ timeoutMs: 60_000 });
  ctx.snapshotWarmupGate = warmupGate;

  // Avoid touching real Homey internals during background bootstrap.
  vi.spyOn(ctx.snapshotHelpers, 'startPeriodicSnapshotRefresh').mockImplementation(() => undefined);
  vi.spyOn(ctx.homeyEnergyHelpers, 'start').mockImplementation(() => undefined);
  vi.mocked(ctx.loadPowerTracker).mockImplementation(() => undefined);
  vi.mocked(ctx.loadPriceOptimizationSettings).mockImplementation(() => undefined);
  vi.mocked(ctx.startHeartbeat).mockImplementation(() => undefined);
  vi.mocked(ctx.updateOverheadToken).mockImplementation(async () => undefined);
  vi.mocked(ctx.registerFlowCards).mockImplementation(() => undefined);
  vi.mocked(ctx.dailyBudgetService!.updateState).mockImplementation(() => undefined);
  vi.mocked(ctx.priceCoordinator!.initOptimizer).mockImplementation(() => undefined);
  vi.mocked(ctx.priceCoordinator!.refreshSpotPrices).mockImplementation(async () => undefined);
  vi.mocked(ctx.priceCoordinator!.refreshGridTariffData).mockImplementation(async () => undefined);
  vi.mocked(ctx.priceCoordinator!.startPriceRefresh).mockImplementation(() => undefined);
  vi.mocked(ctx.priceCoordinator!.startPriceOptimization).mockImplementation(async () => undefined);

  return { ctx, warmupGate, timers };
};

describe('bootstrapSnapshotAndPlan warmup gate integration', () => {
  it('releases the warmup gate with snapshot_ready after a successful first refresh', async () => {
    const { ctx, warmupGate } = buildBootstrapContext();
    const refreshGate = createDeferred<void>();
    vi.mocked(ctx.refreshTargetDevicesSnapshot).mockImplementation(() => refreshGate.promise);
    vi.mocked(ctx.planService!.rebuildPlanFromCache).mockImplementation(async () => undefined as never);

    void startAppServices(ctx);
    await flushMicrotasks();
    expect(warmupGate.isReleased()).toBe(false);
    expect(ctx.planService!.rebuildPlanFromCache).not.toHaveBeenCalled();

    refreshGate.resolve(undefined);
    await flushMicrotasks();

    expect(warmupGate.isReleased()).toBe(true);
    expect(warmupGate.getReleaseReason()).toBe('snapshot_ready');
    expect(ctx.planService!.rebuildPlanFromCache).toHaveBeenCalledWith('startup_snapshot_bootstrap');
  });

  it('releases with timeout reason when the first refreshSnapshot rejects so startup completes', async () => {
    const { ctx, warmupGate } = buildBootstrapContext();
    const refreshError = new Error('homey manager unavailable');
    vi.mocked(ctx.refreshTargetDevicesSnapshot).mockImplementation(async () => {
      throw refreshError;
    });
    vi.mocked(ctx.planService!.rebuildPlanFromCache).mockImplementation(async () => undefined as never);

    await startAppServices(ctx);
    // Bootstrap runs in the background; let it complete.
    await flushMicrotasks();

    expect(warmupGate.isReleased()).toBe(true);
    expect(warmupGate.getReleaseReason()).toBe('timeout');
    // The rebuild call is still attempted (with empty snapshot, which is fine
    // — the next snapshot refresh will re-build with a populated snapshot).
    // The important assertion is the gate released and startup did not hang.
  });

  it('does not block rebuildPlanFromCache once the gate has released', async () => {
    const { ctx, warmupGate } = buildBootstrapContext();
    vi.mocked(ctx.refreshTargetDevicesSnapshot).mockImplementation(async () => undefined);
    vi.mocked(ctx.planService!.rebuildPlanFromCache).mockImplementation(async () => undefined as never);

    await startAppServices(ctx);
    await flushMicrotasks();
    expect(warmupGate.isReleased()).toBe(true);

    // After the gate released, follow-up rebuild calls run without waiting.
    let secondSettled = false;
    void ctx.planService!.rebuildPlanFromCache('post_warmup').then(() => {
      secondSettled = true;
    });
    await flushMicrotasks();
    expect(secondSettled).toBe(true);
  });
});

describe('PlanService.rebuildPlanFromCache warmup gate', () => {
  it('waits on an unreleased gate before queuing the rebuild', async () => {
    // Verify directly against PlanService with a stub deps object so the
    // queue/perfCounters wiring is exercised without standing up the full
    // engine.
    const buildDevicePlanSnapshot = vi.fn(async () => ({ meta: {}, devices: [] } as never));
    const warmupGate = new SnapshotWarmupGate({ timeoutMs: 60_000 });

    const { PlanService } = await import('../../lib/plan/planService');
    const planService = new PlanService({
      homey: { settings: { set: vi.fn() } } as never,
      planEngine: {
        buildDevicePlanSnapshot,
        syncPendingTargetCommands: vi.fn(),
        syncPendingBinaryCommands: vi.fn(),
        prunePendingTargetCommands: vi.fn(),
        state: {},
      } as never,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      snapshotWarmupGate: warmupGate,
    });

    let rebuildSettled = false;
    void planService.rebuildPlanFromCache('test').then(() => {
      rebuildSettled = true;
    });
    await flushMicrotasks();
    expect(buildDevicePlanSnapshot).not.toHaveBeenCalled();
    expect(rebuildSettled).toBe(false);

    warmupGate.release('snapshot_ready');
    await flushMicrotasks();
    // The engine's buildDevicePlanSnapshot is now reachable; the rebuild
    // still has follow-up async work in PlanService, so we just assert the
    // gate stopped blocking the call into the engine.
    expect(buildDevicePlanSnapshot).toHaveBeenCalled();
  });

  it('holds a concurrent non-bootstrap rebuild (e.g. price/settings) until the gate releases', async () => {
    // This is the core regression: during the warmup window a price refresh
    // or settings-change-triggered rebuild must NOT run against an empty
    // snapshot. The previous behavior emitted a one-cycle
    // `deferred_objective_unknown reasonCode:objective_missing_device`
    // event for any objective whose device hadn't landed in the snapshot
    // yet.
    const buildDevicePlanSnapshot = vi.fn(async () => ({ meta: {}, devices: [] } as never));
    const warmupGate = new SnapshotWarmupGate({ timeoutMs: 60_000 });

    const { PlanService } = await import('../../lib/plan/planService');
    const planService = new PlanService({
      homey: { settings: { set: vi.fn() } } as never,
      planEngine: {
        buildDevicePlanSnapshot,
        syncPendingTargetCommands: vi.fn(),
        syncPendingBinaryCommands: vi.fn(),
        prunePendingTargetCommands: vi.fn(),
        state: {},
      } as never,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      snapshotWarmupGate: warmupGate,
    });

    // Simulate a price-coordinator rebuild arriving during the warmup window.
    void planService.rebuildPlanFromCache('price optimization (cheap hour)');
    void planService.rebuildPlanFromCache('settings:capacity_changed');
    void planService.rebuildPlanFromCache('flow_card:set_priority');
    await flushMicrotasks();
    expect(buildDevicePlanSnapshot).not.toHaveBeenCalled();

    warmupGate.release('snapshot_ready');
    await flushMicrotasks();
    expect(buildDevicePlanSnapshot).toHaveBeenCalled();
  });

  it('skips the gate wait once released so steady-state rebuilds are not delayed', async () => {
    const buildDevicePlanSnapshot = vi.fn(async () => ({ meta: {}, devices: [] } as never));
    const warmupGate = new SnapshotWarmupGate({ timeoutMs: 0 });
    expect(warmupGate.isReleased()).toBe(true);

    const { PlanService } = await import('../../lib/plan/planService');
    const planService = new PlanService({
      homey: { settings: { set: vi.fn() } } as never,
      planEngine: {
        buildDevicePlanSnapshot,
        syncPendingTargetCommands: vi.fn(),
        syncPendingBinaryCommands: vi.fn(),
        prunePendingTargetCommands: vi.fn(),
        state: {},
      } as never,
      getPlanDevices: () => [],
      getCapacityDryRun: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getCombinedPrices: () => null,
      getLastPowerUpdate: () => null,
      snapshotWarmupGate: warmupGate,
    });

    void planService.rebuildPlanFromCache('test');
    await flushMicrotasks();
    expect(buildDevicePlanSnapshot).toHaveBeenCalled();
  });
});
