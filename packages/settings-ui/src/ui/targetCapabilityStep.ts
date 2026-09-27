import type { TargetCapabilitySnapshot } from '../../../contracts/src/types.ts';

const DEFAULT_TEMPERATURE_TARGET_STEP = 0.5;

// The increment a setpoint input steps by: the capability's own step when it
// reports a usable one, else half a degree.
export const getTargetCapabilityStep = (
  target?: Partial<Pick<TargetCapabilitySnapshot, 'step'>> | null,
  fallback = DEFAULT_TEMPERATURE_TARGET_STEP,
): number => {
  const step = target?.step;
  if (typeof step === 'number' && Number.isFinite(step) && step > 0) return step;
  return fallback;
};
