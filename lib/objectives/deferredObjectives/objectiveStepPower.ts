/**
 * Resolves the calibrated power for a stepped-load device's step, falling back
 * to the step's nameplate power when the calibration store has no confident
 * observation for the pair. The bucket
 * allocator consumes this value via {@link DeferredObjectiveStep.usefulPowerKw},
 * so capping at nameplate prevents an over-delivering observation from
 * making horizon plans optimistic; flooring at zero keeps malformed input
 * from corrupting the allocator.
 */
import type { ObjectiveDeviceInput } from '../../objectives/types';

export function resolveStepDeliveryUsefulKw(
  device: ObjectiveDeviceInput,
  stepId: string,
  nameplateKw: number,
): number {
  // The producer (`appInit.buildStepPowerCalibrationView`) already capped each
  // entry at nameplate, so callers here only fall back to nameplate when no
  // calibration entry exists or the stored value is unusable.
  const calibrated = device.stepPowerCalibration?.[stepId];
  if (typeof calibrated === 'number' && Number.isFinite(calibrated) && calibrated >= 0) {
    return calibrated;
  }
  return Math.max(0, nameplateKw);
}
