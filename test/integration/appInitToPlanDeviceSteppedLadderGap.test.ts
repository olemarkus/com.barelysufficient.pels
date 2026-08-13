/**
 * Producer coverage for the STEP-LADDER GAP bit (`steppedLadderMissing`).
 *
 * The gap is "configured as a stepped load, but no live ladder resolved this
 * cycle". It is a real, recurring runtime state — a flow-registered stepped
 * profile does not survive an app restart until the Flow re-fires, and SDK reads
 * fail transiently — and the smart-task stack must tell it apart from "this
 * device was never stepped": prod 2026-08-01, a stepped water heater lost its
 * profile across a restart and its COMMITTED task degraded to `unknown` for 9.5 h,
 * losing its budget exemption.
 *
 * `toPlanDevice` is the only place both halves of the question are visible at
 * once (the configured intent, and the ladder the planner will actually run), so
 * it resolves the gap (`resolveSteppedLadderMissing`) and the consumers read it
 * flat (`resolveObjectiveSteps` in
 * `lib/objectives/deferredObjectives/objectiveSteps.ts`, `resolvePlanningSpeedKw`
 * in `lib/objectives/deferredObjectives/planningSpeed.ts`).
 *
 * Two describes, deliberately: the first pins the producer's rule in isolation,
 * the second feeds real producer output straight into both consumers so a
 * producer-side regression fails a consumer-side assertion — the JOIN, which is
 * what actually broke in production and what neither half covers alone. The same
 * join across a full restart (commit → frozen serve → settle → rollover) is
 * `test/e2e/deferredObjectiveStepGapRestartSdkE2E.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { resolveObjectiveSteps } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import { resolvePlanningSpeedKw } from '../../lib/objectives/deferredObjectives/planningSpeed';
import type { DecoratedDeviceSnapshot, SteppedLoadProfile } from '../../packages/contracts/src/types';

const USABLE_LADDER: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1_250 },
    { id: 'max', planningPowerW: 3_000 },
  ],
};

const buildSnapshot = (overrides: Partial<DecoratedDeviceSnapshot>): DecoratedDeviceSnapshot => ({
  id: 'tank',
  name: 'Water heater',
  expectedPowerKw: 1,
  expectedPowerSource: 'default',
  targets: [],
  binaryControl: { on: false },
  ...overrides,
});

describe('toPlanDevice step-ladder gap', () => {
  it('flags a stepped-configured device whose live ladder is absent', () => {
    // The restart shape: the configured intent survives in settings, the
    // flow-registered ladder does not.
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'stepped_load',
    }));

    expect(isSteppedLoadDevice(planDevice)).toBe(false);
    expect(planDevice.steppedLadderMissing).toBe(true);
  });

  it('flags a stepped-configured device whose ladder prices no rung', () => {
    // The other way the cluster comes up empty: a ladder IS in hand, but no rung
    // of it yields a finite planning power, so `resolveSteppedClusterFields`
    // refuses the pair. Same gap — the planner has no stepped answer either way.
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }] },
    }));

    expect(isSteppedLoadDevice(planDevice)).toBe(false);
    expect(planDevice.steppedLadderMissing).toBe(true);
  });

  it('leaves the bit off when the ladder resolves', () => {
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
    }));

    expect(isSteppedLoadDevice(planDevice)).toBe(true);
    // Absent, not `false` — one spelling for "no gap", like `surplusOnly`.
    expect('steppedLadderMissing' in planDevice).toBe(false);
  });

  it('leaves the bit off for a device that was never stepped', () => {
    // The distinction the whole bit exists for: a plain binary device also
    // reaches the planner with no profile, and it is NOT in a gap — the
    // smart-task stack may synthesise a charge rate for it.
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'binary_power',
    }));

    expect('steppedLadderMissing' in planDevice).toBe(false);
  });

  it('leaves the bit off for a stepped device whose temperature control is disabled', () => {
    // `projectEffectiveControlDevice` re-projects this device to plain binary
    // power for the whole cycle — it is honestly not stepped right now, so there
    // is no ladder to be missing.
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      temperatureControlDisabled: true,
    }));

    expect(isSteppedLoadDevice(planDevice)).toBe(false);
    expect('steppedLadderMissing' in planDevice).toBe(false);
  });
});

/**
 * The JOIN: the producer's real output, fed straight to the consumers.
 *
 * The two blocks above cover the producer in isolation and the e2e
 * (`test/e2e/deferredObjectiveStepGapRestartSdkE2E.test.ts`) covers the consumers
 * from a `PlanInputDevice` fixture — the same shape its canonical sibling
 * `deferredObjectiveColdStartSdkE2E.test.ts` uses. Neither tier crosses the seam,
 * and the seam is what failed in prod on 2026-08-01: a bit that the producer stops
 * stamping, or stamps under a renamed key, would leave both of those tiers green
 * while the incident reopened.
 *
 * So these cases build NO device fixture. `toPlanDevice` output goes directly into
 * `resolveObjectiveSteps` / `resolvePlanningSpeedKw`, which means a producer-side
 * regression fails a consumer-side assertion — the only arrangement that actually
 * guards the gap end to end.
 */
describe('step-ladder gap: producer output through the consumers', () => {
  it('makes both consumers withhold for the restart shape', () => {
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'stepped_load',
      targets: [{ id: 'target_temperature', value: 70, unit: 'C', min: 0, max: 95, step: 0.5 }],
      deviceType: 'temperature',
    }));

    // Not asserted as a precondition — read back so a failure here names the
    // producer rather than blaming the consumers for its omission.
    expect(planDevice.steppedLadderMissing).toBe(true);
    expect(resolveObjectiveSteps(planDevice)).toEqual([]);
    expect(resolvePlanningSpeedKw(planDevice)).toBeNull();
  });

  it('lets both consumers answer once the ladder resolves', () => {
    // The negative control. Same device, ladder present: the gap is not stamped
    // and neither consumer withholds — so the case above is proving the gap, not
    // some unrelated reason these two return empty.
    const planDevice = toPlanDevice(createAppContextMock(), buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      targets: [{ id: 'target_temperature', value: 70, unit: 'C', min: 0, max: 95, step: 0.5 }],
      deviceType: 'temperature',
    }));

    expect('steppedLadderMissing' in planDevice).toBe(false);
    expect(resolveObjectiveSteps(planDevice).length).toBeGreaterThan(0);
    expect(resolvePlanningSpeedKw(planDevice)).not.toBeNull();
  });
});
