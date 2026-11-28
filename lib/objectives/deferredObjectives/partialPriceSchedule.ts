import type {
  DeferredObjectiveActivePlanFloorShortfallCause, DeferredObjectivePartialPriceSchedule, DeferredObjectivePlanInterval,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { resolveCurrentHourBooking, resolveCurrentHourClaim } from './currentHourClaim';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import type { DeferredObjectiveHorizonPlan } from './types';

const HOUR_MS = 3_600_000;
const EPSILON_KWH = 0.001;

type TimeWindow = { startsAtMs: number; endsAtMs: number };

const projectedWork = (startsAtMs: number, durationMs: number, speedKw: number): DeferredObjectivePlanInterval => ({
  startsAtMs, endsAtMs: startsAtMs + durationMs, plannedKWh: speedKw * durationMs / HOUR_MS,
});

const availableWindows = (plan: DeferredObjectiveHorizonPlan): TimeWindow[] => {
  const gaps: TimeWindow[] = [];
  let startsAtMs = plan.horizonStartMs;
  // Walk the allocator's chronological intervals once to exclude paid work.
  /* eslint-disable functional/immutable-data */
  for (const bucket of plan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    if (bucket.startMs > startsAtMs) gaps.push({ startsAtMs, endsAtMs: bucket.startMs });
    startsAtMs = Math.max(startsAtMs, bucket.endMs);
  }
  if (startsAtMs < plan.horizonEndMs) gaps.push({ startsAtMs, endsAtMs: plan.horizonEndMs });
  /* eslint-enable functional/immutable-data */
  return gaps;
};

const buildFallbackWindows = (
  plan: DeferredObjectiveHorizonPlan, speedKw: number, started: boolean,
): DeferredObjectivePlanInterval[] => {
  const windows = availableWindows(plan);
  let remainingMs = (plan.unplannedUsefulEnergyKWh / speedKw) * HOUR_MS;
  const bookFromStart = ({ startsAtMs, endsAtMs }: TimeWindow): DeferredObjectivePlanInterval[] => {
    const duration = Math.min(Math.max(0, endsAtMs - startsAtMs), remainingMs);
    remainingMs -= duration;
    return duration > 0 ? [projectedWork(startsAtMs, duration, speedKw)] : [];
  };
  // Live progress can shorten an active run without postponing it.
  if (started) return windows.flatMap(bookFromStart);
  // Count backward before the normal deadline reserve. A priced commitment
  // already contributes to the remaining goal and cannot supply extra time.
  const beforeReserve: DeferredObjectivePlanInterval[] = [];
  /* eslint-disable functional/immutable-data -- Only the local result is changed. */
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index]!;
    const end = Math.min(window.endsAtMs, plan.planningEndMs);
    const duration = Math.min(Math.max(0, end - window.startsAtMs), remainingMs);
    remainingMs -= duration;
    if (duration > 0) beforeReserve.push(projectedWork(end - duration, duration, speedKw));
  }
  beforeReserve.reverse();
  /* eslint-enable functional/immutable-data */
  const inReserve = windows.flatMap(({ startsAtMs, endsAtMs }) => bookFromStart({
    startsAtMs: Math.max(startsAtMs, plan.planningEndMs), endsAtMs,
  }));
  return [...beforeReserve, ...inReserve];
};

export const servePartialPriceSchedule = (
  plan: DeferredObjectiveHorizonPlan,
  partialPriceSchedule: DeferredObjectivePartialPriceSchedule,
  floorShortfallCause: DeferredObjectiveActivePlanFloorShortfallCause = resolveFloorShortfallCause(plan.statusDetail),
): DeferredObjectiveHorizonPlan => {
  const booking = resolveCurrentHourBooking(plan.currentBucket);
  const hasPricedWorkNow = booking === 'booked_with_energy' || booking === 'booked_continuous';
  const fallbackStart = partialPriceSchedule.fallbackStartsAtMs;
  const runsOnAvailablePower = fallbackStart !== undefined && plan.horizonStartMs >= fallbackStart;
  if (!hasPricedWorkNow && runsOnAvailablePower) {
    return { ...plan, partialPriceSchedule, currentHourClaim: 'claimed', runsOnAvailablePower: true };
  }
  // A shortage of published periods does not claim idle intervals.
  const currentHourClaim = hasPricedWorkNow
    ? resolveCurrentHourClaim(booking, plan.currentHourFacts, floorShortfallCause)
    : 'released';
  return { ...plan, partialPriceSchedule, currentHourClaim };
};

const fallbackEnergyKWh = (windows: readonly DeferredObjectivePlanInterval[]): number => (
  windows.reduce((total, interval) => total + interval.plannedKWh, 0)
);

export const remainingUnscheduledEnergyKWh = (plan: DeferredObjectiveHorizonPlan): number => (
  Math.max(0, plan.unplannedUsefulEnergyKWh - fallbackEnergyKWh(plan.partialPriceSchedule?.fallbackWindows ?? []))
);

const projectFallback = (
  plan: DeferredObjectiveHorizonPlan,
  speedKw: number | undefined,
  savedStart: number | undefined,
): DeferredObjectivePartialPriceSchedule => {
  if (speedKw === undefined || plan.unplannedUsefulEnergyKWh <= EPSILON_KWH) return { fallbackWindows: [] };
  const ongoing = savedStart !== undefined && savedStart <= plan.horizonStartMs;
  const fallbackWindows = buildFallbackWindows(plan, speedKw, ongoing);
  const first = fallbackWindows[0];
  if (!first) return { fallbackWindows };
  return { fallbackWindows, fallbackStartsAtMs: ongoing ? savedStart : first.startsAtMs };
};

export const withPartialPriceSchedule = (
  plan: DeferredObjectiveHorizonPlan,
  speedKw: number | undefined,
  savedSchedule: DeferredObjectivePartialPriceSchedule | undefined,
): DeferredObjectiveHorizonPlan => {
  if (speedKw === undefined && plan.plannedUsefulEnergyKWh <= EPSILON_KWH) return plan;
  const partialPriceSchedule = projectFallback(plan, speedKw, savedSchedule?.fallbackStartsAtMs);
  const { fallbackWindows } = partialPriceSchedule;
  const coversNeed = fallbackEnergyKWh(fallbackWindows) >= plan.unplannedUsefulEnergyKWh - EPSILON_KWH;
  const usesDeadlineReserve = plan.usesDeadlineReserve
    || (fallbackWindows.at(-1)?.endsAtMs ?? 0) > plan.planningEndMs;
  const resolved = coversNeed && fallbackWindows.length > 0 ? {
    ...plan,
    status: usesDeadlineReserve ? 'at_risk' as const : 'on_track' as const,
    statusDetail: usesDeadlineReserve ? 'planned_using_deadline_reserve' as const : 'planned_with_margin' as const,
    budgetContributedToShortfall: false,
    usesDeadlineReserve,
  } : plan;
  return servePartialPriceSchedule(resolved, partialPriceSchedule);
};
