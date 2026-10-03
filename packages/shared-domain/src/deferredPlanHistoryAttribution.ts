import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';
import type { TaskDeliveryCause } from '../../contracts/src/taskDelivery';

export type DeferredPlanHistoryMissCause = TaskDeliveryCause | 'legacy_unrecorded';
export type DeferredPlanHistoryMissAttribution = {
  cause: DeferredPlanHistoryMissCause | null;
  contributors: TaskDeliveryCause[];
  plannedKWh: number | null;
  deliveredKWh: number | null;
  planningSpeedKw: number | null;
  rateConfidence: 'low' | 'medium' | 'high' | null;
  acceptedSamples: number | null;
  dailyBudgetExhaustedBucketCount: number;
};
type AttributionEntry = Pick<ResolvedDeferredObjectivePlanHistoryEntry,
  'outcome' | 'deliveryExplanation' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'>;

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

  return {
    cause: resolveRecordedCause(entry),
    contributors: evidence.kind === 'recorded' ? evidence.contributors : [],
    plannedKWh: snapshot === null ? null : snapshot.hours.reduce((sum, hour) => sum + hour.plannedKWh, 0),
    deliveredKWh: entry.deliveredKWh ?? null,
    planningSpeedKw: snapshot?.planningSpeedKw ?? null,
    rateConfidence: snapshot?.rateConfidence ?? null,
    acceptedSamples: snapshot?.acceptedSamples ?? null,
    dailyBudgetExhaustedBucketCount: snapshot?.dailyBudgetExhaustedBucketCount ?? 0,
  };
};

const CAUSE_COPY: Record<DeferredPlanHistoryMissCause, string> = {
  capacity_limited: 'Power-limit control held delivery back.',
  budget_limited: 'The daily budget held delivery back.',
  priority_limited: 'Higher-priority devices held delivery back.',
  device_not_accepting: 'The device stopped accepting energy before reaching the target.',
  device_limit: 'The device has its own limit below the requested target.',
  device_schedule: 'The device paused delivery for its own schedule.',
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

export const formatRefinedMissCause = (entry: AttributionEntry): string | null => {
  const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
  if (attribution.cause === null) return null;
  const contributors = attribution.contributors.filter((cause) => cause !== attribution.cause);
  const earlier = contributors.map((cause) => CAUSE_COPY[cause]).join(' ');
  return `${CAUSE_COPY[attribution.cause]}${earlier ? ` Earlier: ${earlier}` : ''}`;
};
