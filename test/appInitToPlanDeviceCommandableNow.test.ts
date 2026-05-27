/**
 * Coverage for `toPlanDevice`'s commandableNow enrichment (chunk 2 of the
 * planner-detype refactor): the producer seam must populate
 * `commandableNow` + `commandableNowReason` on every `PlanInputDevice` so
 * planner consumers can read the resolved bit instead of branching on raw
 * `evChargingState` / `available`.
 *
 * The abandon-grace contract (resolver behaviour) is covered separately in
 * `deviceActionProjectionCommandableNow.test.ts`; here we verify the
 * `toPlanDevice → AppContext.lastKnownCommandableByDevice` write-back loop
 * end-to-end.
 */
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../lib/app/appInit';
import { createAppContextMock } from './helpers/appContextTestHelpers';
import type { AppContext } from '../lib/app/appContext';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { COMMANDABLE_NOW_GRACE_MS } from '../lib/device/deviceActionProjection';

const FIXED_NOW = new Date('2026-05-26T12:00:00Z').getTime();

const buildEvSnapshot = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'ev-1',
  name: 'EV charger',
  targets: [],
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  currentOn: false,
  ...overrides,
}) as TargetDeviceSnapshot;

const ctxAtFixedNow = (): AppContext => {
  const ctx = createAppContextMock();
  (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW);
  return ctx;
};

describe('toPlanDevice — commandableNow producer wiring', () => {
  it('populates commandableNow=true for a plugged-in EV charger', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    expect(result.commandableNow).toBe(true);
    expect(result.commandableNowReason).toBeNull();
  });

  it('populates commandableNow=false with a reason for a plugged-out EV charger', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_out' }));
    expect(result.commandableNow).toBe(false);
    expect(result.commandableNowReason).toBe('charger is unplugged');
  });

  it('writes the resolved observation back into AppContext.lastKnownCommandableByDevice', () => {
    const ctx = ctxAtFixedNow();
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_charging' }));
    expect(ctx.lastKnownCommandableByDevice['ev-1']).toEqual({
      commandableNow: true,
      observedAtMs: FIXED_NOW,
    });
  });

  it('inherits a prior commandableNow=true through a transient empty EV read (abandon-grace)', () => {
    const ctx = ctxAtFixedNow();
    // Seed the grace window with a recent confident observation.
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    // Advance time *within* the grace window, then deliver an uncertain
    // read (no evChargingState). The producer must keep commandableNow=true.
    (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW + 60_000);
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: undefined }));
    expect(result.commandableNow).toBe(true);
    expect(result.commandableNowReason).toBeNull();
  });

  it('drops to commandableNow=false on an empty EV read outside the grace window', () => {
    const ctx = ctxAtFixedNow();
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    // Beyond grace: the prior observation no longer applies.
    (ctx as unknown as { getNow: () => Date }).getNow = () => (
      new Date(FIXED_NOW + COMMANDABLE_NOW_GRACE_MS + 5_000)
    );
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: undefined }));
    expect(result.commandableNow).toBe(false);
    expect(result.commandableNowReason).toBe('charger state unknown');
  });

  it('does not extend the grace window when the current read is uncertain', () => {
    // A succession of uncertain reads must not keep re-anchoring the
    // observedAtMs, otherwise the grace window becomes infinite.
    const ctx = ctxAtFixedNow();
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    const seededAt = ctx.lastKnownCommandableByDevice['ev-1']?.observedAtMs;
    (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW + 60_000);
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: undefined }));
    // The seeded observedAtMs must survive an uncertain read; the grace
    // window now ticks against the original confident observation.
    expect(ctx.lastKnownCommandableByDevice['ev-1']?.observedAtMs).toBe(seededAt);
  });
});
