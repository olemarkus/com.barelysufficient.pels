/**
 * A deferred `binary_restore` (an EV deadline resume) is the only release intent
 * that drives a positive, turn-ON command, so it must not be attached to a plan
 * built on a stale power sample — issuing it would race the capacity guard on
 * data it cannot trust. `binary_release` and `shed_release` are negative commands
 * and stay safe under stale power.
 *
 * This used to be asserted end to end through the reconcile lane, which had to
 * re-stamp freshness onto the plan it re-applied (`stampCurrentPowerFreshness`)
 * precisely because that plan had been built at a different moment. With the
 * reconcile lane gone, the guard sits where it belongs — at build time, in the
 * producer of the intent — and this pins it there directly.
 */
import { describe, expect, it } from 'vitest';
import { attachDeferredReleaseIntents } from '../../lib/plan/planBuilderDecoration';
import type { PlanContext } from '../../lib/plan/planContext';
import type { DevicePlan } from '../../lib/plan/planTypes';

type PlanDevice = DevicePlan['devices'][number];

const evDevice = (): PlanDevice => ({
  id: 'ev-1',
  name: 'EV Charger',
  currentState: 'off',
  plannedState: 'keep',
  controllable: true,
  binaryCapabilityId: 'evcharger_charging',
  deviceClass: 'evcharger',
  currentOn: false,
} as unknown as PlanDevice);

// The gate is now "did this cycle measure", not which stale state it was in —
// the planner is not told the difference. The parameterised cases below still
// name each freshness state, because that is what produces each answer.
const contextWithMeasurement = (powerIsMeasured: boolean): PlanContext =>
  ({ powerIsMeasured } as unknown as PlanContext);

describe('attachDeferredReleaseIntents — power measurement gate', () => {
  it('attaches a binary_restore intent when the cycle has a measurement', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_restore' },
      contextWithMeasurement(true),
    );

    expect(result[0].deferredReleaseIntent).toBe('binary_restore');
  });

  it('withholds a binary_restore intent on an unmeasured cycle', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_restore' },
      contextWithMeasurement(false),
    );

    expect(result[0].deferredReleaseIntent).toBeUndefined();
  });

  it('still attaches the negative binary_release intent on an unmeasured cycle', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_release' },
      contextWithMeasurement(false),
    );

    expect(result[0].deferredReleaseIntent).toBe('binary_release');
  });
});
