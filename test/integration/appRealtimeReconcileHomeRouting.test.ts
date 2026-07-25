// Integration coverage for the R7b realtime-reconcile owning-home routing
// (`setup/appRealtimeDeviceReconcileRuntime.ts` +
// `HomeRuntimeRegistry.getReconcileHooksForDevice`): an external on/off change
// to a SUB-home load must be drift-checked and reconciled through THAT home's
// bundle, not main's (main's plan filters sub-home members out, so main would
// silently drop the drift). A MAIN-home device still reconciles through
// `ctx.planService` exactly as before — the single-home path is unchanged.
//
// Only the reconcile targets are stubbed (the two plan services and the
// owning-home router); the real wrapper drives its debounce timer, drift gate,
// and flush queue. Drift is forced via a null reconcile snapshot (the wrapper
// treats a missing snapshot as drift), so the reconcile actually fires.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { scheduleAppRealtimeDeviceReconcileForApp } from '../../setup/appRealtimeDeviceReconcileRuntime';
import { createRealtimeDeviceReconcileState } from '../../setup/appRealtimeDeviceReconcile';
import type { RealtimeReconcileHooks } from '../../setup/homeRuntime/createHomeCapacityBundle';
import type { AppContext } from '../../lib/app/appContext';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { drainPending } from '../utils/asyncDrain';

// The reconcile debounce is 250 ms; advance past it to fire the flush.
const RECONCILE_ADVANCE_MS = 300;

type ReconcileMock = Mock<() => Promise<boolean>>;
const makeReconcile = (): ReconcileMock => vi.fn(async (): Promise<boolean> => true);

// No typed PlanService mock helper exists (see appContextTestHelpers gap); the
// wrapper only reads `getLatestReconcilePlanSnapshot` (null → forced drift) and
// `reconcileLatestPlanState`, so a two-method partial is the established idiom.
const buildCtx = (mainReconcile: ReconcileMock): AppContext => createAppContextMock({
  latestTargetSnapshot: [],
  planService: {
    getLatestReconcilePlanSnapshot: () => null,
    reconcileLatestPlanState: mainReconcile,
  } as unknown as AppContext['planService'],
});

const subHooks = (reconcile: ReconcileMock): RealtimeReconcileHooks => ({
  getLatestPlanSnapshot: () => null,
  getLiveDevices: () => [],
  reconcile,
  hasPendingBinaryCommand: () => false,
  rebuild: () => Promise.resolve(),
  isDryRun: () => false,
});

const routerFor = (
  hooksByDeviceId: Record<string, RealtimeReconcileHooks>,
): { getReconcileHooksForDevice: (deviceId: string) => RealtimeReconcileHooks | undefined } => ({
  getReconcileHooksForDevice: (deviceId) => hooksByDeviceId[deviceId],
});

describe('realtime-device-reconcile owning-home routing (R7b P1#1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes a sub-home device realtime reconcile to THAT bundle, not main', async () => {
    const subReconcile = makeReconcile();
    const mainReconcile = makeReconcile();
    const ctx = buildCtx(mainReconcile);
    const router = routerFor({ 'sub-dev': subHooks(subReconcile) });

    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: { deviceId: 'sub-dev', name: 'Annex heater', capabilityId: 'onoff' },
      state: createRealtimeDeviceReconcileState(),
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => router,
    });
    await vi.advanceTimersByTimeAsync(RECONCILE_ADVANCE_MS);
    await drainPending();

    // The owning sub-home's plan service reconciled; main's was never touched.
    expect(subReconcile).toHaveBeenCalledTimes(1);
    expect(mainReconcile).not.toHaveBeenCalled();
  });

  it('reconciles a MAIN-home device through main (the router yields no sub-home hooks)', async () => {
    const subReconcile = makeReconcile();
    const mainReconcile = makeReconcile();
    const ctx = buildCtx(mainReconcile);
    // Router owns 'sub-dev' only; 'main-dev' resolves to undefined → main path.
    const router = routerFor({ 'sub-dev': subHooks(subReconcile) });

    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: { deviceId: 'main-dev', capabilityId: 'onoff' },
      state: createRealtimeDeviceReconcileState(),
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => router,
    });
    await vi.advanceTimersByTimeAsync(RECONCILE_ADVANCE_MS);
    await drainPending();

    expect(mainReconcile).toHaveBeenCalledTimes(1);
    expect(subReconcile).not.toHaveBeenCalled();
  });
});
