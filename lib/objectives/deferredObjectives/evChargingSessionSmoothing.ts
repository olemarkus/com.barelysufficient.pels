import type { PriceHorizonEntry } from '../../../packages/planner-types/src/priceHorizon';
import type { DeferredObjectivePlanInterval } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { resolveCurrentBucketPlan } from './horizonPlanner';
import { needsEveryHour, resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import { buildDeferredObjectivePolicyBucketPrices } from './policyHorizon';
import { hasCheaperEnergyHourAhead } from './priceBand';
import { getActiveObjectiveSteps, normalizeObjectiveSteps } from './stepSelection';
import type { DeferredObjectiveHorizonPlan, DeferredObjectivePlannedBucket, DeferredObjectiveStep } from './types';

const MAX_GAP_MS = 15 * 60_000;
const MAX_COST_PREMIUM = 0.05;
const ENERGY_EPSILON_KWH = 0.001;
const ROUNDING_EPSILON = 1e-9;

type ChargingRun = { first: number; last: number };
type PlanCost = { money: number; planning: number };

const chargingRuns = (buckets: readonly DeferredObjectivePlannedBucket[]): ChargingRun[] => {
  const runs: ChargingRun[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (!bucket.booked) continue;
    const previous = runs.at(-1);
    if (previous && previous.last === index - 1 && buckets[previous.last]?.endMs === bucket.startMs) {
      // eslint-disable-next-line functional/immutable-data -- Local run accumulator.
      previous.last = index;
    } else {
      // eslint-disable-next-line functional/immutable-data -- Local run accumulator.
      runs.push({ first: index, last: index });
    }
  }
  return runs;
};

const planCost = (
  buckets: readonly DeferredObjectivePlannedBucket[],
  moneyPrices: ReadonlyMap<string, number>,
): PlanCost | undefined => {
  let money = 0;
  let planning = 0;
  for (const bucket of buckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    const moneyPrice = moneyPrices.get(bucket.sourceBucketId);
    if (moneyPrice === undefined || bucket.price === null) return undefined;
    money += bucket.plannedUsefulEnergyKWh * moneyPrice;
    planning += bucket.plannedUsefulEnergyKWh * bucket.price;
  }
  return { money, planning };
};

const withinCostBound = (candidate: number, baseline: number): boolean => (
  candidate <= baseline + Math.max(0, baseline) * MAX_COST_PREMIUM
    + ROUNDING_EPSILON * Math.max(Math.abs(baseline), Math.abs(candidate))
);

const runStep = (
  buckets: readonly DeferredObjectivePlannedBucket[],
  run: ChargingRun,
  steps: readonly DeferredObjectiveStep[],
): DeferredObjectiveStep | undefined => {
  const first = buckets[run.first];
  if (!first || first.plannedUsefulEnergyKWh <= 0) return undefined;
  const matching = steps.filter((step) => step.admissionPowerKw === first.plannedAdmissionPowerKw);
  if (matching.length !== 1) return undefined;
  return buckets.slice(run.first, run.last + 1).every((bucket) => (
    bucket.plannedUsefulEnergyKWh > 0 && bucket.plannedAdmissionPowerKw === first.plannedAdmissionPowerKw
  )) ? matching[0] : undefined;
};

const gapCanRun = (
  buckets: readonly DeferredObjectivePlannedBucket[],
  left: ChargingRun,
  right: ChargingRun,
  step: DeferredObjectiveStep,
  nativeQuarterIds: ReadonlySet<string>,
): boolean => {
  const before = buckets[left.last];
  const after = buckets[right.first];
  if (!before || !after || after.startMs - before.endMs > MAX_GAP_MS || right.first <= left.last + 1) return false;
  let endMs = before.endMs;
  for (const bucket of buckets.slice(left.last + 1, right.first)) {
    const neededKWh = step.usefulPowerKw * bucket.durationHours;
    if (!nativeQuarterIds.has(bucket.sourceBucketId) || bucket.startMs !== endMs || bucket.reserve || neededKWh <= 0
      || neededKWh > bucket.usefulEnergyCapacityKWh + ROUNDING_EPSILON) return false;
    endMs = bucket.endMs;
  }
  return endMs === after.startMs;
};

const bridgeRuns = (
  buckets: readonly DeferredObjectivePlannedBucket[],
  left: ChargingRun,
  right: ChargingRun,
  step: DeferredObjectiveStep,
): DeferredObjectivePlannedBucket[] | undefined => {
  const bridged = buckets.map((bucket) => ({ ...bucket }));
  let transferredKWh = 0;
  for (const bucket of bridged.slice(left.last + 1, right.first)) {
    const energyKWh = step.usefulPowerKw * bucket.durationHours;
    transferredKWh += energyKWh;
    // eslint-disable-next-line functional/immutable-data -- Mutating the candidate's own buckets.
    Object.assign(bucket, {
      plannedUsefulEnergyKWh: energyKWh, plannedAdmissionPowerKw: step.admissionPowerKw, booked: true,
    });
  }
  for (let index = right.last; index >= right.first && transferredKWh > 0; index -= 1) {
    const bucket = bridged[index];
    if (!bucket) continue;
    const movedKWh = Math.min(transferredKWh, bucket.plannedUsefulEnergyKWh);
    transferredKWh -= movedKWh;
    const remainingKWh = bucket.plannedUsefulEnergyKWh - movedKWh;
    // eslint-disable-next-line functional/immutable-data -- Mutating the candidate's own buckets.
    Object.assign(bucket, { plannedUsefulEnergyKWh: remainingKWh,
      plannedAdmissionPowerKw: remainingKWh > 0 ? step.admissionPowerKw : 0,
      booked: remainingKWh > 0, keepCharging: false });
  }
  if (transferredKWh > ROUNDING_EPSILON) return undefined;
  for (const bucket of bridged.slice(left.first, right.last + 1)) {
    // eslint-disable-next-line functional/immutable-data -- Mark only the resulting run, not removed donors.
    bucket.keepCharging = bucket.booked;
  }
  return bridged;
};

const findImprovement = (
  buckets: DeferredObjectivePlannedBucket[],
  steps: DeferredObjectiveStep[],
  moneyPrices: ReadonlyMap<string, number>,
  baseline: PlanCost,
  nativeQuarterIds: ReadonlySet<string>,
): DeferredObjectivePlannedBucket[] | undefined => {
  const runs = chargingRuns(buckets);
  for (let index = 0; index < runs.length - 1; index += 1) {
    const left = runs[index];
    const right = runs[index + 1];
    if (!left || !right) continue;
    const step = runStep(buckets, left, steps);
    if (!step || runStep(buckets, right, steps)?.id !== step.id
      || !gapCanRun(buckets, left, right, step, nativeQuarterIds)) continue;
    const candidate = bridgeRuns(buckets, left, right, step);
    if (!candidate || chargingRuns(candidate).length >= runs.length) continue;
    const cost = planCost(candidate, moneyPrices);
    if (cost && withinCostBound(cost.money, baseline.money) && withinCostBound(cost.planning, baseline.planning)) {
      return candidate;
    }
  }
  return undefined;
};

const refreshPlan = (
  plan: DeferredObjectiveHorizonPlan,
  plannedBuckets: DeferredObjectivePlannedBucket[],
  steps: DeferredObjectiveStep[],
): DeferredObjectiveHorizonPlan => {
  const currentBucket = resolveCurrentBucketPlan(plannedBuckets, normalizeObjectiveSteps(steps), ENERGY_EPSILON_KWH);
  const current = plannedBuckets.find((bucket) => bucket.current);
  const currentHourFacts = { ...plan.currentHourFacts,
    cheaperHourAhead: current !== undefined && hasCheaperEnergyHourAhead(plannedBuckets, current, ENERGY_EPSILON_KWH) };
  return { ...plan, plannedBuckets, currentBucket, currentHourFacts,
    expectedStepId: currentBucket?.expectedStepId ?? null,
    currentHourClaim: resolveCurrentHourClaim(resolveCurrentHourBooking(currentBucket), currentHourFacts,
      resolveFloorShortfallCause(plan.statusDetail)) };
};

const replayCommittedRuns = (
  plan: DeferredObjectiveHorizonPlan,
  steps: DeferredObjectiveStep[],
  commitment: readonly DeferredObjectivePlanInterval[],
): DeferredObjectiveHorizonPlan => {
  if (!commitment.some((interval) => interval.keepCharging === true)) return plan;
  const needsFreeCapacity = needsEveryHour(resolveFloorShortfallCause(plan.statusDetail));
  const plannedBuckets = plan.plannedBuckets.map((bucket) => {
    const coverage = commitment.filter((interval) => (
      (interval.coversFromMs ?? interval.startsAtMs) <= bucket.startMs && interval.endsAtMs >= bucket.endMs
    ));
    return { ...bucket,
      // Preserve selected coverage: a pricier bridge must not rebook its cheap donor at zero energy.
      booked: bucket.booked && (needsFreeCapacity || bucket.plannedUsefulEnergyKWh > 0 || coverage.length > 0),
      keepCharging: bucket.plannedUsefulEnergyKWh > 0 && coverage.some((interval) => interval.keepCharging === true) };
  });
  return refreshPlan(plan, plannedBuckets, steps);
};

/** Fresh EV bookings prefer fewer starts within one cumulative 5% money and planning-value allowance. */
export const smoothEvChargingPlan = (
  plan: DeferredObjectiveHorizonPlan,
  steps: DeferredObjectiveStep[],
  priceHorizon: readonly PriceHorizonEntry[],
  commitment: DeferredObjectivePlanInterval[] | undefined,
): DeferredObjectiveHorizonPlan => {
  if (commitment !== undefined) return replayCommittedRuns(plan, steps, commitment);
  if (plan.unplannedUsefulEnergyKWh > ENERGY_EPSILON_KWH || plan.usesDeadlineReserve
    || plan.status !== 'on_track') return plan;
  const nativeQuarterIds = new Set(priceHorizon
    .filter((period) => period.endMs - period.startMs === MAX_GAP_MS)
    .map((period) => new Date(period.startMs).toISOString()));
  if (nativeQuarterIds.size === 0) return plan;
  const moneyPrices = buildDeferredObjectivePolicyBucketPrices(priceHorizon);
  const baseline = planCost(plan.plannedBuckets, moneyPrices);
  if (!baseline) return plan;
  const activeSteps = getActiveObjectiveSteps(normalizeObjectiveSteps(steps));
  let buckets = plan.plannedBuckets;
  let next = findImprovement(buckets, activeSteps, moneyPrices, baseline, nativeQuarterIds);
  while (next) {
    buckets = next;
    next = findImprovement(buckets, activeSteps, moneyPrices, baseline, nativeQuarterIds);
  }
  return buckets === plan.plannedBuckets ? plan : refreshPlan(plan, buckets, steps);
};
