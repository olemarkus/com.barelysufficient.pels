import type { DeferredObjectiveStep } from './types';

// Sanitise a rung's grid draw. Not a resolution — `DeferredObjectiveStep` requires
// the field and both producers set it — but this is a normalizer, and it already
// declines to trust `usefulPowerKw`'s type either (see the finiteness filter below).
// A junk value falls back to useful power, the right reading for a resistive load
// where draw and delivery are the same thing. Deliberately not exported: consumers
// read the field flat, and re-running this downstream is what made a value the
// producer had already decided look like every caller's problem.
const sanitizeStepAdmissionPowerKw = (step: DeferredObjectiveStep): number => (
  Number.isFinite(step.admissionPowerKw) && step.admissionPowerKw >= 0
    ? step.admissionPowerKw
    : step.usefulPowerKw
);

export const normalizeObjectiveSteps = (
  steps: readonly DeferredObjectiveStep[],
): DeferredObjectiveStep[] => (
  steps
    .filter((step) => (
      typeof step.id === 'string'
      && step.id.trim() !== ''
      && Number.isFinite(step.usefulPowerKw)
      && step.usefulPowerKw >= 0
    ))
    .map((step) => ({
      id: step.id.trim(),
      usefulPowerKw: step.usefulPowerKw,
      admissionPowerKw: sanitizeStepAdmissionPowerKw(step),
    }))
    .sort((left, right) => left.usefulPowerKw - right.usefulPowerKw || left.id.localeCompare(right.id))
);

/**
 * The highest step whose admission power fits a headroom forecast, or `null` when
 * there is no usable forecast to fit against.
 *
 * Two callers, wanting OPPOSITE defaults when there is no forecast — which is why
 * this returns `null` rather than choosing one:
 *
 *   - `resolveStepForBucket` (`horizonPlanner.ts`) picks the rung a FULLY-RESERVED
 *     task's plan COMMITS to per hour, and falls back to the FLOOR rung: a
 *     commitment may not promise more than the producer has verified.
 *   - the two feasibility probes fall back to the TOP rung: nothing physical is
 *     known, and a probe should not invent a limit.
 *
 * The probes need the fit at all because `resolveBucketStepCapacityKWh` still
 * applies a rate test on the CONTENDED path — where a higher-priority task's
 * admission power is a real simultaneous draw — and would zero a bucket probed at a
 * rung that does not fit the residual. On the uncontended path the hour is bounded
 * by its headroom ENERGY instead, so no rung is excluded there.
 *
 * When even the lowest step exceeds the forecast this returns that lowest step, not
 * `null`: it is still the best available choice, and the energy ceiling downstream
 * is what limits what the hour can actually hold.
 */
export const resolveHighestStepWithinHeadroom = (
  activeSteps: readonly [DeferredObjectiveStep, ...DeferredObjectiveStep[]],
  reservedHeadroomKw: number | undefined,
): DeferredObjectiveStep | null => {
  if (typeof reservedHeadroomKw !== 'number' || !Number.isFinite(reservedHeadroomKw)) return null;
  // `activeSteps` is sorted ascending by useful power (`normalizeObjectiveSteps`),
  // so the last rung that fits is the highest one that fits. The lowest rung is
  // the answer when none fits (see the docblock).
  let fitting: DeferredObjectiveStep = activeSteps[0];
  for (const step of activeSteps) {
    if (step.admissionPowerKw <= reservedHeadroomKw) fitting = step;
  }
  return fitting;
};

export const getActiveObjectiveSteps = (
  steps: DeferredObjectiveStep[],
): DeferredObjectiveStep[] => (
  steps.filter((step) => step.usefulPowerKw > 0)
);

export const selectMinimumStepForEnergy = (params: {
  steps: DeferredObjectiveStep[];
  energyKWh: number;
  durationHours: number;
  epsilonKWh: number;
}): DeferredObjectiveStep | null => {
  const {
    steps,
    energyKWh,
    durationHours,
    epsilonKWh,
  } = params;
  if (energyKWh <= epsilonKWh || durationHours <= 0) return null;
  const activeSteps = getActiveObjectiveSteps(steps);
  for (const step of activeSteps) {
    if ((step.usefulPowerKw * durationHours) + epsilonKWh >= energyKWh) {
      return step;
    }
  }
  return activeSteps.at(-1) ?? null;
};
