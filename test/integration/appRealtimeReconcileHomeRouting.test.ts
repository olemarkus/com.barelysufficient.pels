// Integration coverage for the R7b realtime-reconcile owning-home routing
// (`setup/appRealtimeDeviceReconcileRuntime.ts` +
// `HomeRuntimeRegistry.getReconcileRouteForDevice`): an external on/off change
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
import { createExternalOffHoldPolicy } from '../../setup/externalOffHoldAdapter';
import {
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { buildPlanDevice } from '../utils/planTestUtils';

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
  clearRecentBinaryOffCommand: () => undefined,
  rebuild: () => Promise.resolve(),
});

const routerFor = (
  routesByDeviceId: Record<string, { homeId: string; hooks: RealtimeReconcileHooks }>,
): {
    getReconcileRouteForDevice: (
      deviceId: string,
    ) => { homeId: string; hooks: RealtimeReconcileHooks } | undefined;
  } => ({
  getReconcileRouteForDevice: (deviceId) => routesByDeviceId[deviceId],
});

const subRoute = (
  homeId: string,
  reconcile: ReconcileMock,
): { homeId: string; hooks: RealtimeReconcileHooks } => ({
  homeId,
  hooks: subHooks(reconcile),
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
    const router = routerFor({ 'sub-dev': subRoute('h_sub', subReconcile) });

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
    const router = routerFor({ 'sub-dev': subRoute('h_sub', subReconcile) });

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

  it('detects a sub-home outside OFF even when that device is filtered out of plan input', () => {
    const settings = new Map<string, unknown>([
      [RESPECT_EXTERNAL_OFF_DEVICES, { 'sub-dev': true }],
    ]);
    const subRebuild = vi.fn(async () => undefined);
    const subReconcile = makeReconcile();
    const mainReconcile = makeReconcile();
    const ctx = createAppContextMock({
      latestTargetSnapshot: [{
        id: 'sub-dev',
        name: 'Annex heater',
        targets: [],
        controlCapabilityId: 'onoff',
        binaryControl: { on: false },
      }],
      planService: {
        getLatestReconcilePlanSnapshot: () => null,
        reconcileLatestPlanState: mainReconcile,
      } as unknown as AppContext['planService'],
    });
    ctx.externalOffHold = createExternalOffHoldPolicy({
      get: (key) => settings.get(key),
      set: (key, value) => { settings.set(key, value); },
    });
    const hooks: RealtimeReconcileHooks = {
      ...subHooks(subReconcile),
      // Mirrors the planned-set filter: the observation must not disappear just
      // because this device is absent from this cycle's plan input.
      getLiveDevices: () => [],
      rebuild: subRebuild,
    };

    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: {
        deviceId: 'sub-dev',
        capabilityId: 'onoff',
        changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
      },
      state: createRealtimeDeviceReconcileState(),
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => routerFor({ 'sub-dev': { homeId: 'h_sub', hooks } }),
    });

    expect(ctx.externalOffHold.isHeld('sub-dev')).toBe(true);
    expect(subRebuild).toHaveBeenCalledWith('external_off_hold_started');
    expect(mainReconcile).not.toHaveBeenCalled();
    expect(subReconcile).not.toHaveBeenCalled();
  });

  it('reconciles MAIN and sub-home drift independently inside one debounce window', async () => {
    const subReconcile = makeReconcile();
    const mainReconcile = makeReconcile();
    const ctx = buildCtx(mainReconcile);
    const router = routerFor({ 'sub-dev': subRoute('h_sub', subReconcile) });
    const state = createRealtimeDeviceReconcileState();

    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: { deviceId: 'main-dev', capabilityId: 'onoff' },
      state,
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => router,
    });
    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: { deviceId: 'sub-dev', capabilityId: 'onoff' },
      state,
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => router,
    });
    await vi.advanceTimersByTimeAsync(RECONCILE_ADVANCE_MS);
    await drainPending();

    expect(mainReconcile).toHaveBeenCalledTimes(1);
    expect(subReconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles two sub-homes independently inside one debounce window', async () => {
    const firstSubReconcile = makeReconcile();
    const secondSubReconcile = makeReconcile();
    const mainReconcile = makeReconcile();
    const ctx = buildCtx(mainReconcile);
    const router = routerFor({
      'first-sub-dev': subRoute('h_first', firstSubReconcile),
      'second-sub-dev': subRoute('h_second', secondSubReconcile),
    });
    const state = createRealtimeDeviceReconcileState();

    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: { deviceId: 'first-sub-dev', capabilityId: 'onoff' },
      state,
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => router,
    });
    scheduleAppRealtimeDeviceReconcileForApp({
      ctx,
      event: { deviceId: 'second-sub-dev', capabilityId: 'onoff' },
      state,
      timers: ctx.timers,
      getHomeRuntimeRegistry: () => router,
    });
    await vi.advanceTimersByTimeAsync(RECONCILE_ADVANCE_MS);
    await drainPending();

    expect(firstSubReconcile).toHaveBeenCalledTimes(1);
    expect(secondSubReconcile).toHaveBeenCalledTimes(1);
    expect(mainReconcile).not.toHaveBeenCalled();
  });

  it.each(['keep', 'shed', 'inactive'] as const)(
    'starts an outside-off hold regardless of the current %s plan state',
    (plannedState) => {
      const settings = new Map<string, unknown>([
        [RESPECT_EXTERNAL_OFF_DEVICES, { 'heater-1': true }],
      ]);
      const rebuild = vi.fn(async () => undefined);
      const plan: DevicePlan = {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [buildPlanDevice({
          id: 'heater-1',
          name: 'Water heater',
          plannedState,
        })],
      };
      const ctx = createAppContextMock({
        latestTargetSnapshot: [{
          id: 'heater-1',
          name: 'Water heater',
          targets: [],
          controlCapabilityId: 'onoff',
          binaryControl: { on: false },
        }],
        planService: {
          getLatestReconcilePlanSnapshot: () => plan,
          rebuildPlanFromCache: rebuild,
        } as unknown as AppContext['planService'],
      });
      ctx.externalOffHold = createExternalOffHoldPolicy({
        get: (key) => settings.get(key),
        set: (key, value) => { settings.set(key, value); },
      });

      scheduleAppRealtimeDeviceReconcileForApp({
        ctx,
        event: {
          deviceId: 'heater-1',
          capabilityId: 'onoff',
          changes: [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }],
        },
        state: createRealtimeDeviceReconcileState(),
        timers: ctx.timers,
      });

      expect(ctx.externalOffHold.isHeld('heater-1')).toBe(true);
      expect(rebuild).toHaveBeenCalledWith('external_off_hold_started');
    },
  );
});
