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
import { projectPreviewPlanDevice, toPlanDevice } from '../setup/appInit';
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

  it('populates canSetControlResolved=true for a plugged-in EV with default canSetControl', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({
      evChargingState: 'plugged_in_paused',
      canSetControl: true,
    }));
    expect(result.canSetControlResolved).toBe(true);
  });

  it('populates canSetControlResolved=false when canSetControl is explicitly false', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({
      evChargingState: 'plugged_in_paused',
      canSetControl: false,
    }));
    expect(result.canSetControlResolved).toBe(false);
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

describe('projectPreviewPlanDevice — read-only grace-window isolation', () => {
  // Regression for the plan-preview "must be strictly read-only" invariant. The
  // preview projects a candidate device through the same `toPlanDevice`
  // producer as the live cycle, but it must NOT re-anchor the live
  // abandon-grace store: a UI calling the preview repeatedly under flaky SDK
  // reads would otherwise keep a no-longer-commandable device's grace window
  // alive across plan cycles ("never let abandon-grace go effectively
  // infinite").
  const buildChargingEv = (): TargetDeviceSnapshot => (
    // A confident `plugged_in_charging` read is exactly the case that triggers
    // `recordCommandableObservation` — so projecting it WOULD write back.
    buildEvSnapshot({ evChargingState: 'plugged_in_charging' })
  );

  it('leaves AppContext.lastKnownCommandableByDevice deep-equal before vs after a preview projection', () => {
    const ctx = ctxAtFixedNow();
    // Seed a *stale* prior observation so any write-through would be visible as
    // a changed observedAtMs (not merely an idempotent re-write of the same
    // value).
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW + 60_000);
    const before = structuredClone(ctx.lastKnownCommandableByDevice);

    projectPreviewPlanDevice(ctx, buildChargingEv());

    // The live record must be byte-for-byte unchanged: the producer's
    // grace-window write landed on the throwaway shallow copy, not here.
    expect(ctx.lastKnownCommandableByDevice).toEqual(before);
  });

  it('still resolves commandableNow against the live grace observations (fidelity preserved)', () => {
    const ctx = ctxAtFixedNow();
    // Seed a confident commandable=true observation, then deliver an *uncertain*
    // read inside the grace window. A faithful projection must inherit
    // commandableNow=true from the seeded observation — proving the preview
    // READS the live record even though it does not WRITE to it.
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW + 60_000);
    const before = structuredClone(ctx.lastKnownCommandableByDevice);

    const projected = projectPreviewPlanDevice(ctx, buildEvSnapshot({ evChargingState: undefined }));

    expect(projected.commandableNow).toBe(true);
    expect(projected.commandableNowReason).toBeNull();
    // And reading the grace window must not have mutated it either.
    expect(ctx.lastKnownCommandableByDevice).toEqual(before);
  });

  it('proves the projected device WOULD write back when not isolated (guards the test)', () => {
    // Sanity guard: confirm the chosen device genuinely triggers a
    // grace-window write through the un-isolated producer, so the read-only
    // assertion above is meaningful rather than vacuously true.
    const ctx = ctxAtFixedNow();
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_paused' }));
    (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW + 60_000);
    const seededAt = ctx.lastKnownCommandableByDevice['ev-1']?.observedAtMs;

    toPlanDevice(ctx, buildChargingEv());

    expect(ctx.lastKnownCommandableByDevice['ev-1']?.observedAtMs).toBe(FIXED_NOW + 60_000);
    expect(ctx.lastKnownCommandableByDevice['ev-1']?.observedAtMs).not.toBe(seededAt);
  });
});
