// Integration coverage for R7b owning-home routing of everything a realtime
// device observation now touches (`HomeRuntimeRegistry.getOwningHomeRouteForDevice`).
// Main's answer to any of these is wrong for a sub-home device in a way that looks
// plausible, so each has to be asked of the home that OWNS the device:
//
//   - the external-off hold (`setup/appObservedControlStateRuntime.ts`) — main's
//     pending-command store never saw the device's commands, so it would report
//     PELS's own write as an outside action and fabricate a hold;
//   - the rebuild-suppression invalidation — each bundle keeps its own
//     `PowerSampleRebuildState`, so clearing main's leaves the owning home
//     holding a "nothing is actionable" verdict about a house that changed.
//
// This lane used to request a plan rebuild too, and most of this file tested
// where that rebuild was routed. It does not any more: a device event is not what
// a whole-home capacity decision is about (root `AGENTS.md` § Control Flow).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateOwningHomeRebuildSuppression,
  syncExternalOffHoldForObservation,
} from '../../setup/appObservedControlStateRuntime';
import type { OwningHomeHooks } from '../../setup/homeRuntime/createHomeCapacityBundle';
import type { AppContext } from '../../lib/app/appContext';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { createExternalOffHoldPolicy } from '../../setup/externalOffHoldAdapter';
import { RESPECT_EXTERNAL_OFF_DEVICES } from '../../lib/utils/settingsKeys';

const OUTSIDE_OFF = [{ capabilityId: 'onoff', previousValue: 'on', nextValue: 'off' }];

const buildCtx = (): AppContext => {
  const settings = new Map<string, unknown>([[RESPECT_EXTERNAL_OFF_DEVICES, { 'sub-dev': true, 'main-dev': true }]]);
  const ctx = createAppContextMock({
    latestTargetSnapshot: ['sub-dev', 'main-dev'].map((id) => ({
      available: true,
      id,
      expectedPowerKw: 1,
      expectedPowerSource: 'default' as const,
      name: id,
      targets: [],
      binaryCapabilityId: 'onoff',
      binaryControl: { on: false },
      binaryControlObservation: {
        valid: true as const,
        capabilityId: 'onoff',
        observedValue: false,
        observedCapabilityIds: ['onoff'],
        observedAtMs: Date.now(),
        source: 'realtime_capability' as const,
      },
    })),
  });
  ctx.externalOffHold = createExternalOffHoldPolicy({
    get: (key) => settings.get(key) ?? null,
    set: (key, value) => { settings.set(key, value); },
    unset: (key) => { settings.delete(key); },
    getKeys: () => Array.from(settings.keys()),
  });
  return ctx;
};

const routerFor = (
  routesByDeviceId: Record<string, { homeId: string; hooks: OwningHomeHooks }>,
): { getOwningHomeRouteForDevice: (deviceId: string) => { homeId: string; hooks: OwningHomeHooks } | undefined } => ({
  getOwningHomeRouteForDevice: (deviceId) => routesByDeviceId[deviceId],
});

describe('owning-home routing of a realtime device observation (R7b P1#1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the OWNING sub-home whether the off was PELS or an outsider', () => {
    const ctx = buildCtx();
    const subPending = vi.fn(() => false);
    const mainPending = vi.fn(() => true);
    ctx.planEngine = {
      hasAttributablePendingBinaryCommand: mainPending,
      clearRecentBinaryOffCommand: vi.fn(),
    } as unknown as AppContext['planEngine'];
    const hooks: OwningHomeHooks = {
      hasPendingBinaryCommand: subPending,
      clearRecentBinaryOffCommand: vi.fn(),
      rebuildPlan: () => Promise.resolve(),
      invalidateRebuildSuppression: vi.fn(),
    };

    syncExternalOffHoldForObservation({
      ctx,
      event: { deviceId: 'sub-dev', capabilityId: 'onoff', changes: OUTSIDE_OFF },
      getHomeRuntimeRegistry: () => routerFor({ 'sub-dev': { homeId: 'h_sub', hooks } }),
    });

    // Main's engine would have called this PELS's own write and held nothing.
    expect(subPending).toHaveBeenCalledWith('sub-dev');
    expect(mainPending).not.toHaveBeenCalled();
    expect(ctx.externalOffHold?.isHeld('sub-dev')).toBe(true);
  });

  it('falls back to main for a device no sub-home owns', () => {
    const ctx = buildCtx();
    const mainPending = vi.fn(() => false);
    ctx.planEngine = {
      hasAttributablePendingBinaryCommand: mainPending,
      clearRecentBinaryOffCommand: vi.fn(),
    } as unknown as AppContext['planEngine'];

    syncExternalOffHoldForObservation({
      ctx,
      event: { deviceId: 'main-dev', capabilityId: 'onoff', changes: OUTSIDE_OFF },
      getHomeRuntimeRegistry: () => routerFor({}),
    });

    expect(mainPending).toHaveBeenCalledWith('main-dev');
    expect(ctx.externalOffHold?.isHeld('main-dev')).toBe(true);
  });

  // Ported from the deleted reconcile-routing spec. The property is still live
  // and is now only STRUCTURALLY enforced — the hooks bag no longer carries a plan
  // snapshot, so the hold decision cannot read plan state even by accident. This
  // fails if someone puts one back.
  it.each(['keep', 'shed', 'inactive'])(
    'starts an outside-off hold regardless of the current %s plan state',
    (plannedState) => {
      const ctx = buildCtx();
      ctx.planService = {
        getLatestPlanSnapshot: () => ({ devices: [{ id: 'main-dev', plannedState }] }),
      } as unknown as AppContext['planService'];
      ctx.planEngine = {
        hasAttributablePendingBinaryCommand: () => false,
        clearRecentBinaryOffCommand: vi.fn(),
      } as unknown as AppContext['planEngine'];

      syncExternalOffHoldForObservation({
        ctx,
        event: { deviceId: 'main-dev', capabilityId: 'onoff', changes: OUTSIDE_OFF },
        getHomeRuntimeRegistry: () => routerFor({}),
      });

      expect(ctx.externalOffHold?.isHeld('main-dev')).toBe(true);
    },
  );

  it('requests no plan rebuild — the hold is state the next reading plans with', () => {
    const ctx = buildCtx();
    const rebuildPlanFromCache = vi.fn();
    ctx.planService = { rebuildPlanFromCache } as unknown as AppContext['planService'];
    ctx.planEngine = {
      hasAttributablePendingBinaryCommand: () => false,
      clearRecentBinaryOffCommand: vi.fn(),
    } as unknown as AppContext['planEngine'];
    const rebuildPlan = vi.fn(() => Promise.resolve());

    syncExternalOffHoldForObservation({
      ctx,
      event: { deviceId: 'sub-dev', capabilityId: 'onoff', changes: OUTSIDE_OFF },
      getHomeRuntimeRegistry: () => routerFor({
        'sub-dev': {
          homeId: 'h_sub',
          hooks: {
            hasPendingBinaryCommand: () => false,
            clearRecentBinaryOffCommand: vi.fn(),
            rebuildPlan,
            invalidateRebuildSuppression: vi.fn(),
          },
        },
      }),
    });

    expect(ctx.externalOffHold?.isHeld('sub-dev')).toBe(true);
    expect(rebuildPlan).not.toHaveBeenCalled();
    expect(rebuildPlanFromCache).not.toHaveBeenCalled();
  });
});

// The suppression invalidation is the seam this file exists to guard: unlike the
// hold, it writes a field that main and every sub-home hold SEPARATELY, so an
// unrouted write is silent — main's state changes (a house that saw nothing) and
// the owning home's does not (the one whose "nothing is actionable" verdict the
// moved device just falsified, worth up to 120 s of tight-noop backoff).
describe('rebuild-suppression invalidation routing (R7b P1#1)', () => {
  const buildCtxWithSuppressions = (): AppContext => {
    const ctx = createAppContextMock({});
    ctx.powerSampleRebuildState = { lastMs: 1_000, tightNoopStreak: 3, backoffUntilMs: 120_000 };
    return ctx;
  };

  it('clears the OWNING sub-home\'s suppressions and leaves main\'s alone', () => {
    const ctx = buildCtxWithSuppressions();
    const invalidateSubHome = vi.fn();

    invalidateOwningHomeRebuildSuppression({
      ctx,
      deviceId: 'sub-dev',
      getHomeRuntimeRegistry: () => routerFor({
        'sub-dev': {
          homeId: 'h_sub',
          hooks: {
            hasPendingBinaryCommand: () => false,
            clearRecentBinaryOffCommand: vi.fn(),
            rebuildPlan: () => Promise.resolve(),
            invalidateRebuildSuppression: invalidateSubHome,
          },
        },
      }),
    });

    expect(invalidateSubHome).toHaveBeenCalledTimes(1);
    // Main's state is a different house and must not move.
    expect(ctx.powerSampleRebuildState).toMatchObject({ tightNoopStreak: 3, backoffUntilMs: 120_000 });
  });

  it('clears main\'s suppressions when no sub-home owns the device', () => {
    const ctx = buildCtxWithSuppressions();

    invalidateOwningHomeRebuildSuppression({
      ctx,
      deviceId: 'main-dev',
      getHomeRuntimeRegistry: () => routerFor({}),
    });

    expect(ctx.powerSampleRebuildState).toMatchObject({
      shortfallSuppressionInvalidated: true,
      tightNoopStreak: 0,
      backoffUntilMs: undefined,
    });
  });
});
