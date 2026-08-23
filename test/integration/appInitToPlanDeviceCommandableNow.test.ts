/**
 * Coverage for `toPlanDevice`'s commandableNow enrichment: the producer seam
 * populates `commandableNow` + `commandabilityReason` on every `PlanInputDevice`
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
import type { EvObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const FIXED_NOW = new Date('2026-05-26T12:00:00Z').getTime();

const buildEvSnapshot = (
  overrides: Partial<TargetDeviceSnapshot & EvObservedProbe> = {},
): TargetDeviceSnapshot & EvObservedProbe => ({
  id: 'ev-1',
  name: 'EV charger',
  available: true,
  targets: [],
  deviceClass: 'evcharger',
  binaryCapabilityId: 'evcharger_charging',
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
    expect(result.objectiveKind).toBe('ev_soc');
    expect(result).not.toHaveProperty('evChargingState');
  });

  it('populates commandableNow=false for a plugged-out EV charger', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: 'plugged_out' }));
    expect(result.commandableNow).toBe(false);
    expect(result.commandabilityReason).toBe('charger_unplugged');
    expect(result).not.toHaveProperty('evChargingState');
    // The raw plug-state is resolved into TWO distinct answers and then stripped:
    // may-we-command it, and is-there-a-creditable-session. They are not
    // interchangeable — `commandableNow` also goes false for an unavailable
    // device and for PELS's own command back-off, neither of which says anything
    // about the car.
    expect(result.objectiveSessionInactive).toBe(true);
  });

  it('carries the semantic retry reason with a reachability veto', () => {
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(
      ctx,
      buildEvSnapshot({ evChargingState: 'plugged_in_paused' }),
      {
        projectCommandability: () => ({
          commandableNow: false,
          reason: 'binary_command_retry',
        }),
      },
    );

    expect(result.commandableNow).toBe(false);
    expect(result.commandabilityReason).toBe('binary_command_retry');
  });

  it('carries no plug-state for a charger that has no plug-state capability, and leaves it commandable', () => {
    // The `target_power` / stepped-load charger population: `evcharger` by class,
    // no EV capabilities, so no plug state to ask about. Commandability falls
    // through to availability. (A charger that CLAIMS the capability and reports
    // outside the enum never gets this far — it is dropped at parse.)
    const ctx = ctxAtFixedNow();
    const result = toPlanDevice(ctx, buildEvSnapshot({ evChargingState: undefined }));
    expect(result).not.toHaveProperty('evChargingState');
    expect(result.commandableNow).toBe(true);
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
