/**
 * Resolves the conservative-low delivery estimate for a stepped-load
 * device's step, falling back to the step's nameplate power when the
 * calibration store has no confident observation for the pair. The bucket
 * allocator consumes this value via {@link DeferredObjectiveStep.usefulPowerKw},
 * so capping at nameplate prevents an over-delivering observation from
 * making horizon plans optimistic; flooring at zero keeps malformed input
 * from corrupting the allocator.
 */
import type { PlanInputDevice } from '../planTypes';

export function resolveStepDeliveryUsefulKw(
  device: PlanInputDevice,
  stepId: string,
  nameplateKw: number,
): number {
  // The producer (`appInit.buildStepPowerCalibrationView`) already capped the
  // delivery view at nameplate, so callers here only fall back to nameplate
  // when no calibration entry exists or the stored value is unusable.
  const calibrated = device.stepPowerCalibration?.[stepId]?.deliveryPowerKw;
  if (typeof calibrated === 'number' && Number.isFinite(calibrated) && calibrated >= 0) {
    return calibrated;
  }
  return Math.max(0, nameplateKw);
}
