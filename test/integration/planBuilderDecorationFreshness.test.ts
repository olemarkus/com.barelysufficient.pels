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
import type { PowerFreshnessState } from '../../lib/plan/planPowerFreshness';

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

const contextWithFreshness = (powerFreshnessState: PowerFreshnessState): PlanContext =>
  ({ powerFreshnessState } as unknown as PlanContext);

describe('attachDeferredReleaseIntents — power freshness gate', () => {
  it('attaches a binary_restore intent when the power sample is fresh', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_restore' },
      contextWithFreshness('fresh'),
    );

    expect(result[0].deferredReleaseIntent).toBe('binary_restore');
  });

  it.each<PowerFreshnessState>(['stale_hold', 'stale_fail_closed'])(
    'withholds a binary_restore intent when the power sample is %s',
    (powerFreshnessState) => {
      const result = attachDeferredReleaseIntents(
        [evDevice()],
        { 'ev-1': 'binary_restore' },
        contextWithFreshness(powerFreshnessState),
      );

      expect(result[0].deferredReleaseIntent).toBeUndefined();
    },
  );

  it.each<PowerFreshnessState>(['stale_hold', 'stale_fail_closed'])(
    'still attaches the negative binary_release intent when the power sample is %s',
    (powerFreshnessState) => {
      const result = attachDeferredReleaseIntents(
        [evDevice()],
        { 'ev-1': 'binary_release' },
        contextWithFreshness(powerFreshnessState),
      );

      expect(result[0].deferredReleaseIntent).toBe('binary_release');
    },
  );
});
