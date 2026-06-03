import {
  allocateEnergyToBuckets,
  isMeaningfullyCheaper,
  type StepForBucket,
} from './bucketAllocation';
import type { DeferredObjectiveKind, DeferredObjectiveStep } from './types';

// Cold-start price release. The floor-step allocation force-books the current
// hour whenever the guaranteed floor cannot fit the whole need — it fills hours
// cheapest-first, so once the cheaper hours are full the residual spills onto the
// current (relatively expensive) hour (see `bucketAllocation.ts`). For a device
// that can climb to a higher step — a cap-off thermostat runs its full element,
// not the conservative floor step the commitment is sized at — that spill is a
// false premise: the real element will finish inside the cheaper hours. So when a
// later hour is MEANINGFULLY cheaper than the current hour (the same relative
// `isMeaningfullyCheaper` band the allocator and the live deferral use) AND the
// FULL buffered need fits into those cheaper future hours at the climbed step,
// release the current hour so a cheaper hour carries the load.
//
// Unlike `resolvePriceDeferralEligible` this does NOT require the device to be
// ahead of its milestone (at cold start it is behind) and does NOT require the
// cheaper hours to already be booked at the floor step — it proves they can
// absorb the need at the device's real step. Re-evaluated every cycle, so a
// shrinking cheap window or a device slower than its climb step naturally resumes
// driving. Reserve hours are excluded so we never lean on the deadline reserve. A
// non-positive current price makes `isMeaningfullyCheaper` false (run now rather
// than defer on a meaningless ratio). Classification only — never writes a revision.
//
// SCOPE: only bang-bang setpoint-controlled devices (`temperature` thermostats).
// There PELS sets just the target and the element runs at full power, so the climb
// (max) step equals the real deliverable rate and the feasibility proof is exact.
// Throttleable kinds (`ev_soc` amp steps) may not reach the max step when
// capacity-shed in the cheaper hours, so releasing on that upper bound could keep
// deferring until the window can no longer finish — excluded until observed-rate
// feasibility lands (see TODO.md).
export const resolveColdStartReleaseEligible = (params: {
  objectiveKind: DeferredObjectiveKind;
  buckets: Parameters<typeof allocateEnergyToBuckets>[0]['buckets'];
  stepForBucket: StepForBucket;
  climbStep: DeferredObjectiveStep;
  energyNeededKWh: number;
  epsilonKWh: number;
}): boolean => {
  if (params.objectiveKind !== 'temperature') return false;
  const current = params.buckets.find((bucket) => bucket.current);
  // No current bucket, or a current hour with no comparable price, cannot anchor a
  // relative-price release.
  if (!current || current.price == null) return false;
  // Only a device that can climb above the current hour's floor can finish faster
  // than the floor allocation assumes; otherwise the floor booking is real.
  if (params.climbStep.usefulPowerKw <= params.stepForBucket(current).usefulPowerKw) return false;
  const futureCheaper = params.buckets.filter((bucket) => (
    !bucket.current
    && !bucket.reserve
    && bucket.startMs >= current.endMs
    && bucket.price != null
    && isMeaningfullyCheaper(bucket.price, current.price)
  ));
  if (futureCheaper.length === 0) return false;
  const climbed = allocateEnergyToBuckets({
    buckets: futureCheaper,
    stepForBucket: () => params.climbStep,
    energyNeededKWh: params.energyNeededKWh,
    epsilonKWh: params.epsilonKWh,
  });
  return climbed.unplannedUsefulEnergyKWh <= params.epsilonKWh;
};
