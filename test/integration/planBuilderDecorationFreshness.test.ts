/**
 * A deferred `binary_restore` (an EV deadline resume) is the only release intent
 * that drives a positive, turn-ON command, so it rides only a plan built from a
 * MEASUREMENT — the silent-meter pass has no headroom to admit it against.
 * `binary_release` and `shed_release` are negative commands and ride either pass.
 *
 * The guard sits at build time, in the producer of the intent, as a seam
 * argument: the measured pipeline passes `true`, the silent-meter pass `false`.
 * Neither pass reads a flag inside; this pins the argument's meaning.
 */
import { describe, expect, it } from 'vitest';
import { attachDeferredReleaseIntents } from '../../lib/plan/planBuilderDecoration';
import { buildPlanDevice } from '../utils/planTestUtils';
import type { DevicePlan } from '../../lib/plan/planTypes';

type PlanDevice = DevicePlan['devices'][number];

const evDevice = (): PlanDevice => ({
  id: 'ev-1',
  name: 'EV Charger',
  currentState: 'off',
  plannedState: 'keep',
  controllable: true,
  binaryCapabilityId: 'evcharger_charging',
  isEvCharger: true,
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
      () => ({ action: 'turn_off' }),
    );

    expect(result[0].deferredReleaseIntent).toEqual({ kind: 'binary_restore' });
  });

  it('withholds a binary_restore intent when the pass forbids it (the silent-meter pass)', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_restore' },
      false,
      () => ({ action: 'turn_off' }),
    );

    expect(result[0].deferredReleaseIntent).toBeUndefined();
  });

  it('still attaches the negative binary_release intent when binary_restore is forbidden', () => {
    const result = attachDeferredReleaseIntents(
      [evDevice()],
      { 'ev-1': 'binary_release' },
      false,
      () => ({ action: 'turn_off' }),
    );

    expect(result[0].deferredReleaseIntent).toEqual({ kind: 'binary_release' });
  });
});

describe('idle-task release posture', () => {
  it("freezes a cap-off task's configured temperature before execution", () => {
    const device = buildPlanDevice({ controllable: false, shedAction: 'turn_off' });
    let configuredTarget = 15;
    const [resolved] = attachDeferredReleaseIntents(
      [device], { [device.id]: 'shed_release' }, true,
      () => ({ action: 'set_temperature', temperature: configuredTarget }),
    );
    configuredTarget = 20;
    expect(resolved.deferredReleaseIntent).toEqual({
      kind: 'shed_release', posture: { kind: 'target_value', target: 15 },
    });
  });

  it('resolves set_step to binary off when the device has a binary axis', () => {
    const device = buildPlanDevice();
    const [resolved] = attachDeferredReleaseIntents(
      [device], { [device.id]: 'shed_release' }, true, () => ({ action: 'set_step' }),
    );
    expect(resolved.deferredReleaseIntent).toEqual({ kind: 'shed_release', posture: { kind: 'binary_off' } });
  });

  it.each([true, false])('resolves a step-only release on a measured cycle=%s', (measured) => {
    const device = buildPlanDevice({
      binaryControllable: false,
      steppedLoadProfile: { steps: [{ id: 'low', planningPowerW: 500 }, { id: 'high', planningPowerW: 1500 }] },
      selectedStepId: 'high',
      releaseShedStepId: 'low',
    });
    const [resolved] = attachDeferredReleaseIntents(
      [device], { [device.id]: 'shed_release' }, measured, () => ({ action: 'set_step' }),
    );
    expect(resolved.deferredReleaseIntent).toEqual({ kind: 'shed_release', posture: { kind: 'step', stepId: 'low' } });
  });

  it('omits a step release whose target is absent from its selected ladder', () => {
    const device = buildPlanDevice({
      binaryControllable: false,
      steppedLoadProfile: { steps: [{ id: 'low', planningPowerW: 500 }] },
      selectedStepId: 'low',
      releaseShedStepId: null,
    });
    const [resolved] = attachDeferredReleaseIntents(
      [device], { [device.id]: 'shed_release' }, true, () => ({ action: 'set_step' }),
    );
    expect(resolved.deferredReleaseIntent).toBeUndefined();
  });
});
