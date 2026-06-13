/**
 * Coverage for `toPlanDevice`'s `observationStale` reader (stage 4b — first real
 * reader of the observer-owned observed-state projection).
 *
 * Staleness is observed state, so `toPlanDevice` resolves it from
 * `ctx.getObservedState` (the projection's maintained truth) rather than the
 * freshness fields on the passed snapshot. These tests diverge the two sources
 * to prove the projection wins, and that the boot-window fallback to the
 * snapshot holds when no observation has landed yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { STALE_DEVICE_OBSERVATION_MS } from '../../lib/observer/observationFreshness';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';
import type { ObservedDeviceState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const buildSnapshot = (lastFreshDataMs: number): TargetDeviceSnapshot => ({
  id: 'dev-1',
  name: 'Water heater',
  targets: [],
  binaryControl: { on: true },
  lastFreshDataMs,
}) as TargetDeviceSnapshot;

const buildObserved = (lastFreshDataMs: number): ObservedDeviceState => ({
  id: 'dev-1',
  name: 'Water heater',
  targets: [],
  binaryControl: { on: true },
  lastFreshDataMs,
});

describe('toPlanDevice — observationStale reads the observed-state projection', () => {
  // Freeze the clock so the staleness comparison (isDeviceObservationStale reads
  // Date.now() internally) is fully deterministic — no chance of execution delay
  // nudging the boundary.
  const now = new Date('2026-06-06T12:00:00.000Z').getTime();
  const fresh = now;
  const stale = now - (STALE_DEVICE_OBSERVATION_MS + 60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the fresh projection value even when the snapshot is stale', () => {
    const ctx = createAppContextMock();
    (ctx.getObservedState as ReturnType<typeof vi.fn>).mockReturnValue(buildObserved(fresh));
    const result = toPlanDevice(ctx, buildSnapshot(stale));
    expect(result.observationStale).toBe(false);
  });

  it('uses the stale projection value even when the snapshot is fresh', () => {
    const ctx = createAppContextMock();
    (ctx.getObservedState as ReturnType<typeof vi.fn>).mockReturnValue(buildObserved(stale));
    const result = toPlanDevice(ctx, buildSnapshot(fresh));
    expect(result.observationStale).toBe(true);
  });

  it('falls back to the snapshot when the projection has no observation yet', () => {
    const ctx: AppContext = createAppContextMock();
    (ctx.getObservedState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    expect(toPlanDevice(ctx, buildSnapshot(stale)).observationStale).toBe(true);
    expect(toPlanDevice(ctx, buildSnapshot(fresh)).observationStale).toBe(false);
  });

  // #2 decision: the `?? device` fallback is RETAINED (not retired) because not
  // every `toPlanDevice` caller seeds the projection first. The main plan path
  // (`createPlanService.getPlanDevices`) seeds boot-present devices, but the
  // smart-task preview can resolve a device from `getUiPickerDevices()` that was
  // never in the committed snapshot, so the projection has no entry for it. The
  // snapshot's own freshness fields must still drive `observationStale` for that
  // hot-plug/picker device — dropping the fallback would call
  // `isDeviceObservationStale(undefined)`, a silent `unknown → non-stale` flip.
  it('hot-plug/picker device (never seeded, never observed): snapshot freshness still governs, no silent flip', () => {
    const ctx: AppContext = createAppContextMock();
    // Projection empty for this id (a picker-only device, absent from the seed).
    (ctx.getObservedState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    // A genuinely stale snapshot must stay stale (not flip to non-stale).
    expect(toPlanDevice(ctx, buildSnapshot(stale)).observationStale).toBe(true);
  });
});
