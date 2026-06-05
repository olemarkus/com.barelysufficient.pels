/**
 * Coverage for `toPlanDevice`'s commandableNow enrichment: the producer seam
 * populates `commandableNow` + `commandableNowReason` on every `PlanInputDevice`
 * so planner consumers read the resolved bit instead of branching on raw
 * `evChargingState` / `available`.
 *
 * `toPlanDevice` is a pure read projection — it resolves `commandableNow`
 * directly from the consolidated snapshot fields with no abandon-grace window
 * and no live-state write-back. The resolver contract is covered in
 * `deviceActionProjectionCommandableNow.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const FIXED_NOW = new Date('2026-05-26T12:00:00Z').getTime();

const buildEvSnapshot = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'ev-1',
  name: 'EV charger',
  targets: [],
  deviceClass: 'evcharger',
  controlCapabilityId: 'evcharger_charging',
  binaryControl: { on: false },
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

  it('is pessimistic (commandableNow=false) when the EV has no plug state yet', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: undefined }));
    expect(result.commandableNow).toBe(false);
    expect(result.commandableNowReason).toBe('charger state unknown');
  });

  it('does not write back into live AppContext state (pure projection)', () => {
    const ctx = ctxAtFixedNow();
    const before = structuredClone(ctx.lastKnownPowerKw);
    toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_in_charging' }));
    expect(ctx.lastKnownPowerKw).toEqual(before);
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
});
