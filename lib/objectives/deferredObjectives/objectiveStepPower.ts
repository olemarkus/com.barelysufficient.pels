/**
 * Resolves the calibrated power for a stepped-load device's step, falling back
 * to the step's nameplate power when the calibration store has no confident
 * observation for the pair. The bucket
 * allocator consumes this value via {@link DeferredObjectiveStep.usefulPowerKw},
 * so capping at nameplate prevents an over-delivering observation from
 * making horizon plans optimistic; flooring at zero keeps malformed input
 * from corrupting the allocator.
 *
 * Delivery only. Fitting the rung into capacity room reads
 * {@link DeferredObjectiveStep.admissionPowerKw}, which is the nameplate
 * (`objectiveSteps.ts`): a learned figure can sit well below what the rung draws.
 */
import type { ObjectiveDeviceInput } from '../../objectives/types';

export function resolveStepDeliveryUsefulKw(
  device: ObjectiveDeviceInput,
  stepId: string,
  nameplateKw: number,
): number {
  // The producer (`lib/planInput.buildStepPowerCalibrationView`) already capped each
  // entry at nameplate, so callers here only fall back to nameplate when no
  // calibration entry exists or the stored value is unusable.
  const calibrated = device.stepPowerCalibration?.[stepId];
  if (typeof calibrated === 'number' && Number.isFinite(calibrated) && calibrated >= 0) {
    return calibrated;
  }
  return Math.max(0, nameplateKw);
}

/**
 * The device's live draw, but only when it is actually DRAWING.
 *
 * A thermal device's planning speed is "how fast can this thing deliver energy",
 * and its live draw only answers that mid-cycle. An idle panel heater reporting a
 * few watts of standby would otherwise win the candidate ladder outright and give
 * a planning speed of 0.003 kW — turning a schedulable task into one that needs
 * hundreds of hours.
 *
 * This used to be handled upstream, by the resolver dropping any reading at or
 * below `MIN_SIGNIFICANT_POWER_W`. That floor is gone (it made a real 3 W draw
 * indistinguishable from "no meter", which is what licensed rated-power
 * substitution), so the question "is it drawing enough to time against?" is asked
 * here instead — where it is actually being asked — using the same
 * actively-drawing threshold the admission path uses.
 */
// Duplicated from `MIN_ACTIVE_MEASURED_POWER_KW` in `lib/observer/observedPower.ts`
// rather than imported: `lib/objectives` may not depend on `lib/observer`
// (`no-objectives-to-peer-except-power`). Keep the two in step — they answer the
// same question, "is this device drawing or merely idling".
//
// Distinct from `MIN_CREDIBLE_DEVICE_POWER_KW` (5 W) in `lib/objectives/samples.ts`,
// which asks a different question — "is this reading real enough to learn from" —
// and is deliberately an order of magnitude lower.
const ACTIVELY_DRAWING_MIN_KW = 0.05;

export const drawWhenActivelyDrawingKw = (currentDrawKw: number): number | null => (
  currentDrawKw > ACTIVELY_DRAWING_MIN_KW ? currentDrawKw : null
);
