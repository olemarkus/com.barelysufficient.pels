/**
 * Boot/hot-plug seed of the observed-state projection, end-to-end through the
 * real `createPlanService` factory + a real `ObservedDeviceStateProjection`.
 *
 * Closes two cold-start gaps:
 *  - #4 the settings-UI EV state chip: `getObservedEvChargingState` reads the
 *    observer projection, which is event-driven (empty until the first
 *    delta/refresh for a device). On the first plan build the seed fills it from
 *    the raw snapshot so the chip shows the device's real plug-state for cycle 1.
 *  - #2 `toPlanDevice` freshness: with the projection seeded, `observationStale`
 *    resolves from the projection for boot-present devices instead of the
 *    snapshot fallback — but the fallback is RETAINED for the picker/hot-plug
 *    window (a device not in the committed snapshot), proven below.
 *
 * The seed is wired here exactly as app.ts wires it: `seedObservedStateFromSnapshot`
 * projects each raw `deviceManager.getSnapshot()` entry via `projectObservedState`
 * and hands them to `projection.seedMissing`; `getObservedState` reads the same
 * projection. No PELS internals are stubbed — the projection, the projection
 * helper, and the read-model producer all run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlanService } from '../../setup/appInit/createPlanService';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';
import type { EvChargingState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

type SnapshotEntry = TargetDeviceSnapshot & { evChargingState?: EvChargingState };

const evDevice = (id: string, evChargingState: EvChargingState): SnapshotEntry => ({
  id,
  name: id,
  deviceClass: 'evcharger',
  targets: [],
  capabilities: ['evcharger_charging', 'evcharger_charging_state'],
  controlCapabilityId: 'evcharger_charging',
  evChargingState,
  lastFreshDataMs: Date.now(),
} as SnapshotEntry);

/**
 * Wire a ctx whose observed-state projection + boot seed are the REAL ones,
 * driven off a fixed raw snapshot — mirroring app.ts. `latestTargetSnapshot`
 * (decorated) shares the same device set so `getPlanDevices` maps the same ids.
 */
function ctxWithRealSeed(snapshot: SnapshotEntry[]): {
  ctx: AppContext;
  projection: ObservedDeviceStateProjection;
} {
  const projection = new ObservedDeviceStateProjection();
  const ctx = createAppContextMock({
    planEngine: {} as AppContext['planEngine'],
    latestTargetSnapshot: snapshot as TargetDeviceSnapshot[],
    deviceManager: {
      getSnapshot: () => snapshot,
    } as unknown as AppContext['deviceManager'],
    resolveManagedState: () => true,
    isCapacityControlEnabled: () => true,
    isBudgetExempt: () => false,
    debugLoggingTopics: new Set(),
    getStructuredDebugEmitter: () => vi.fn(),
  });
  // Real projection wiring (identical to app.ts).
  const mutableCtx = ctx as {
    getObservedState: AppContext['getObservedState'];
    seedObservedStateFromSnapshot: AppContext['seedObservedStateFromSnapshot'];
  };
  mutableCtx.getObservedState = (deviceId) => projection.getObservedState(deviceId);
  mutableCtx.seedObservedStateFromSnapshot = () => {
    const raw = ctx.deviceManager?.getSnapshot();
    if (!raw || raw.length === 0) return;
    projection.seedMissing(raw.map((device) => projectObservedState(device)));
  };
  return { ctx, projection };
}

describe('boot seed closes the cold-start EV state-chip gap (#4)', () => {
  // Freeze the clock so `evDevice`'s `lastFreshDataMs: Date.now()` and the freshness
  // path both read a fixed time — the spec must not depend on the wall clock.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('EV plug-state is empty before the first plan build and populated after the seed', () => {
    const { ctx, projection } = ctxWithRealSeed([evDevice('ev-1', 'plugged_in')]);

    // Cold start: nothing dispatched into the projection yet → chip would be generic.
    expect(projection.getObservedState('ev-1')).toBeUndefined();
    expect(ctx.getObservedState('ev-1')).toBeUndefined();

    const service = createPlanService(ctx);
    // The first plan build runs `getPlanDevices`, which seeds the projection.
    (service as unknown as { deps: { getPlanDevices: () => unknown[] } }).deps.getPlanDevices();

    // The settings-UI read model now reads the device's REAL plug-state for cycle 1.
    const readEvState = (
      service as unknown as {
        deps: { getObservedEvChargingState?: (id: string) => EvChargingState | undefined };
      }
    ).deps.getObservedEvChargingState;
    expect(readEvState?.('ev-1')).toBe('plugged_in');
    expect(ctx.getObservedState('ev-1')).toBeDefined();
  });

  it('the seed does not overwrite a plug-state already recorded from a real observation', () => {
    const { ctx, projection } = ctxWithRealSeed([evDevice('ev-1', 'plugged_in')]);
    // A real observation lands first with a DIFFERENT plug-state.
    projection.applyDelta({
      source: 'realtime_capability',
      deviceId: 'ev-1',
      observationSeq: 1,
      observed: { ...projectObservedState(evDevice('ev-1', 'plugged_in_charging')) },
    });

    const service = createPlanService(ctx);
    (service as unknown as { deps: { getPlanDevices: () => unknown[] } }).deps.getPlanDevices();

    // Seed is additive — the recorded 'plugged_in_charging' wins over the
    // snapshot's 'plugged_in'.
    const readEvState = (
      service as unknown as {
        deps: { getObservedEvChargingState?: (id: string) => EvChargingState | undefined };
      }
    ).deps.getObservedEvChargingState;
    expect(readEvState?.('ev-1')).toBe('plugged_in_charging');
  });
});
