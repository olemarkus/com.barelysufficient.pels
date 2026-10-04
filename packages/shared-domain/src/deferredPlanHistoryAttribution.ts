import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';
import type { TaskDeliveryCause, TaskDeliveryInterval } from '../../contracts/src/taskDelivery';
import { pickScheduledHours, sumScheduledKWh } from './deferredPlanHistoryShared';

export type DeferredPlanHistoryMissCause = TaskDeliveryCause | 'legacy_unrecorded';
export type DeferredPlanHistoryMissAttribution = {
  cause: DeferredPlanHistoryMissCause | null;
  contributors: TaskDeliveryCause[];
  // Sum of each hour's booking at its start (`pickScheduledHours`), including
  // energy re-booked after a short hour: a `:58` re-plan moves an hour's
  // shortfall into later hours, so it can exceed what the run needed (that is
  // `initialEnergyExpectedKWh`). Telemetry only.
  plannedKWh: number | null;
  deliveredKWh: number | null;
  planningSpeedKw: number | null;
  rateConfidence: 'low' | 'medium' | 'high' | null;
  acceptedSamples: number | null;
  dailyBudgetExhaustedBucketCount: number;
};
type AttributionEntry = Pick<ResolvedDeferredObjectivePlanHistoryEntry,
  'outcome' | 'deliveryExplanation' | 'deliveredKWh' | 'finalPlan' | 'originalPlan' | 'hourStartBookings'>;

const resolveRecordedCause = (entry: AttributionEntry): DeferredPlanHistoryMissCause | null => {
  if (entry.outcome !== 'missed') return null;
  if (entry.deliveryExplanation.kind === 'legacy_unrecorded') return 'legacy_unrecorded';
  const { primary } = entry.deliveryExplanation;
  return primary.kind === 'blocked' ? primary.cause : 'delivery_unfulfilled';
};

/** Attribution is recorded by the delivery owner, never guessed from an energy ratio. */
export const resolveDeferredPlanHistoryMissAttribution = (
  entry: AttributionEntry,
): DeferredPlanHistoryMissAttribution => {
  const snapshot = entry.finalPlan ?? entry.originalPlan;
  const evidence = entry.deliveryExplanation;
  const scheduled = pickScheduledHours(entry);

  return {
    cause: resolveRecordedCause(entry),
    contributors: evidence.kind === 'recorded' ? evidence.contributors : [],
    plannedKWh: scheduled === null ? null : sumScheduledKWh(scheduled),
    deliveredKWh: entry.deliveredKWh ?? null,
    planningSpeedKw: snapshot?.planningSpeedKw ?? null,
    rateConfidence: snapshot?.rateConfidence ?? null,
    acceptedSamples: snapshot?.acceptedSamples ?? null,
    dailyBudgetExhaustedBucketCount: snapshot?.dailyBudgetExhaustedBucketCount ?? 0,
  };
};

const CAUSE_COPY: Record<DeferredPlanHistoryMissCause, string> = {
  // House capacity limiting (hard cap, safe pace, the capacity period's budget),
  // never the per-device Power-limit control toggle it used to be named after.
  capacity_limited: 'Not enough available power held delivery back.',
  budget_limited: 'The daily budget held delivery back.',
  priority_limited: 'Higher-priority devices held delivery back.',
  device_not_accepting: 'The device stopped taking power before reaching the target.',
  // `device_limit` and `device_schedule` have one producer, the EV car link
  // (`lib/device/evCarLinkSelfStop.ts`), so they name the car, as the live copy
  // does (`resolveSmartTaskLiveCause`).
  device_limit: 'The car stopped at its own charge limit, below this smart task’s target.',
  device_schedule: 'The car delayed charging on its own schedule or smart charging.',
  control_pending: 'Delivery was waiting for device control to settle.',
  control_failed: 'PELS could not confirm the requested device setting.',
  uncontrolled: 'Delivery was outside PELS control.',
  observation_unavailable: 'Device power observations were unavailable.',
  progress_unavailable: 'Task progress observations were unavailable.',
  rate_insufficient: 'The device could not deliver the required energy before the deadline.',
  estimate_uncertain: 'The energy estimate could not establish a feasible schedule.',
  delivery_unfulfilled: 'The requested target was not reached during permitted delivery.',
  legacy_unrecorded: 'Delivery blockers were not recorded for this earlier task.',
};

// A settle in progress: the device was waiting for a command to land, which
// every shed and restore passes through. Worth naming when it is the last
// blocker; noise as an earlier one, where it only echoes the hold around it.
const TRANSIENT_CAUSES: ReadonlySet<TaskDeliveryCause> = new Set(['control_pending']);
// The final cause plus the one contributor that held delivery back longest:
// two sentences already wrap to about three lines on a 320 px widget row, and a
// third made the past-task row the tallest thing on it.
const MAX_EARLIER_CONTRIBUTORS = 1;

const blockedMsByCause = (intervals: readonly TaskDeliveryInterval[]): Map<TaskDeliveryCause, number> => {
  const totals = new Map<TaskDeliveryCause, number>();
  for (const interval of intervals) {
    totals.set(interval.cause, (totals.get(interval.cause) ?? 0) + interval.toMs - interval.fromMs);
  }
  return totals;
};

/**
 * Earlier contributors, longest-blocking first. Durations come from the bounded
 * recent interval window (`MAX_DELIVERY_INTERVALS` in `deliveryEvidence.ts`); a
 * contributor that fell out of it ranks as zero, and ties keep first-seen order.
 */
const rankEarlierContributors = (
  attribution: DeferredPlanHistoryMissAttribution,
  intervals: readonly TaskDeliveryInterval[],
): TaskDeliveryCause[] => {
  const totals = blockedMsByCause(intervals);
  return attribution.contributors
    .filter((cause) => cause !== attribution.cause && !TRANSIENT_CAUSES.has(cause))
    .map((cause, order) => ({ cause, order, blockedMs: totals.get(cause) ?? 0 }))
    .sort((left, right) => right.blockedMs - left.blockedMs || left.order - right.order)
    .slice(0, MAX_EARLIER_CONTRIBUTORS)
    .map(({ cause }) => cause);
};

export const formatRefinedMissCause = (entry: AttributionEntry): string | null => {
  const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
  if (attribution.cause === null) return null;
  const intervals = entry.deliveryExplanation.kind === 'recorded' ? entry.deliveryExplanation.intervals : [];
  const earlier = rankEarlierContributors(attribution, intervals).map((cause) => CAUSE_COPY[cause]).join(' ');
  return `${CAUSE_COPY[attribution.cause]}${earlier ? ` Earlier: ${earlier}` : ''}`;
};
