/**
 * A deferred `binary_restore` (an EV deadline resume) is the only release intent
 * that drives a positive, turn-ON command, so it must not be attached to a plan
 * built on a stale power sample — issuing it would race the capacity guard on
 * data it cannot trust. `binary_release` and `shed_release` are negative commands
 * and stay safe under stale power.
 *
 * The guard sits at build time, in the producer of the intent, as a seam
 * argument: the measured pipeline passes `true`, the silent-meter pass `false`.
 * Neither pass reads a flag inside; this pins the argument's meaning.
 */
import { describe, expect, it } from 'vitest';
import { attachDeferredReleaseIntents } from '../../lib/plan/planBuilderDecoration';
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
describe('attachDeferredReleaseIntents — the binary_restore seam', () => {
  it('attaches a binary_restore intent when the cycle has a measurement', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_restore' },
      true,
    );

    expect(result[0].deferredReleaseIntent).toBe('binary_restore');
  });

  it('withholds a binary_restore intent when the pass forbids it (the silent-meter pass)', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_restore' },
      false,
    );

    expect(result[0].deferredReleaseIntent).toBeUndefined();
  });

  it('still attaches the negative binary_release intent when binary_restore is forbidden', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_release' },
      false,
    );

    expect(result[0].deferredReleaseIntent).toBe('binary_release');
  });
});
