import type { TaskDeliveryCause, TaskDeliveryEvidence } from '../../../packages/contracts/src/taskDelivery';
import { resolveRemainingEnergyKWh } from '../../../packages/shared-domain/src/energyQuantities';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import { hasOnlySettleControlPending } from './budgetOnlyMiss';
import { MAX_DELIVERY_INTERVALS, type TaskDeliveryFacts } from './deliveryEvidence';
import type { InProgressRecord } from './planHistoryInProgressState';
import { DELIVERY_EPSILON_KWH } from './taskDeliveryState';

// The lifecycle ticks every 30 seconds. Allow jitter, but never infer
// continuous permitted operation across a missed sequence of ticks.
const MAX_CONTIGUOUS_TICK_MS = 60_000;
const HOUR_MS = 3_600_000;

// Capture an initially feasible booking's rate before idle can remove its
// future commitments. Count only observed permitted time at that rate; the
// full booking does not prove that the device had any opportunity to run.
export type DeviceIdleEvidence = {
  planningSpeedKw: number;
  firstConfirmedAtMs: number | null;
  lastAcceptedAtMs: number | null;
  permittedIdleMs: number;
};

export const isDeviceIdleEvidence = (raw: unknown): raw is DeviceIdleEvidence => {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return isFiniteNumber(value.planningSpeedKw) && value.planningSpeedKw > 0
    && (value.firstConfirmedAtMs === null || isFiniteNumber(value.firstConfirmedAtMs))
    && (value.lastAcceptedAtMs === null || isFiniteNumber(value.lastAcceptedAtMs))
    && isFiniteNumber(value.permittedIdleMs) && value.permittedIdleMs >= 0;
};

const fromFeasiblePlan = (record: InProgressRecord): DeviceIdleEvidence | undefined => {
  const plan = record.originalPlan;
  if (!plan || !plan.planningSpeedKw || (plan.planStatus !== 'on_track' && plan.planStatus !== 'at_risk')) {
    return undefined;
  }
  const remainingEnergyKWh = resolveRemainingEnergyKWh(plan);
  const bookedKWh = plan.hours.reduce((sum, hour) => sum + hour.plannedKWh, 0);
  if (remainingEnergyKWh === null || remainingEnergyKWh > bookedKWh + DELIVERY_EPSILON_KWH) return undefined;
  if (plan.floorShortfallCause !== undefined && plan.floorShortfallCause !== 'none') return undefined;
  return {
    planningSpeedKw: plan.planningSpeedKw, firstConfirmedAtMs: null, lastAcceptedAtMs: null, permittedIdleMs: 0,
  };
};

const isPermittedIdle = (facts: TaskDeliveryFacts, delivery: TaskDeliveryEvidence): boolean => (
  delivery.energyIdle?.kind === 'accepted' && facts.obligation === 'claimed'
    && facts.control.kind === 'permitted' && facts.observation.kind === 'not_drawing'
    && facts.progress.kind === 'known' && facts.deviceConstraint.kind === 'none'
);

const wasPermittedIdle = (delivery: TaskDeliveryEvidence): boolean => (
  delivery.energyIdle?.kind === 'accepted' && delivery.explanation.kind === 'recorded'
    && delivery.explanation.primary.kind === 'blocked'
    && delivery.explanation.primary.cause === 'device_not_accepting'
);

export const observeDeviceIdleEvidence = (
  record: InProgressRecord,
  facts: TaskDeliveryFacts,
  delivery: TaskDeliveryEvidence,
  nowMs: number,
  elapsedMs: number,
): DeviceIdleEvidence | undefined => {
  const previous = record.deviceIdleEvidence;
  if (record.objectiveKind !== 'energy' || !facts.energyIdleEligible || facts.obligation === 'expired') return previous;
  const evidence = previous ?? fromFeasiblePlan(record);
  if (!evidence || delivery.energyIdle?.kind !== 'accepted') return evidence;
  if (!isPermittedIdle(facts, delivery)) return { ...evidence, lastAcceptedAtMs: nowMs };
  const coveredMs = elapsedMs > 0 && elapsedMs <= MAX_CONTIGUOUS_TICK_MS
    && wasPermittedIdle(record.deliveryEvidence) ? elapsedMs : 0;
  return {
    ...evidence,
    firstConfirmedAtMs: evidence.firstConfirmedAtMs ?? nowMs,
    lastAcceptedAtMs: nowMs,
    permittedIdleMs: evidence.permittedIdleMs + coveredMs,
  };
};

const hasOnlyIdleRelatedBlockers = (delivery: TaskDeliveryEvidence, confirmedAtMs: number): boolean => {
  const { explanation } = delivery;
  if (explanation.kind !== 'recorded' || explanation.intervals.length >= MAX_DELIVERY_INTERVALS) return false;
  const isCompatible = (cause: TaskDeliveryCause): boolean => (
    cause === 'device_not_accepting' || cause === 'control_pending' || cause === 'rate_insufficient'
  );
  if (explanation.primary.kind === 'blocked' && explanation.primary.cause !== 'device_not_accepting') return false;
  if (!explanation.contributors.every(isCompatible) || !hasOnlySettleControlPending(explanation)) return false;
  // A rate shortage is compatible only after idling already cost the run
  // delivery. The final plan becoming infeasible cannot retroactively prove
  // that a run started feasible.
  return (!explanation.contributors.includes('rate_insufficient')
    || explanation.intervals.some(({ cause }) => cause === 'rate_insufficient'))
    && explanation.intervals.every(({ cause, fromMs }) => (
      isCompatible(cause) && (cause !== 'rate_insufficient' || fromMs >= confirmedAtMs)
    ));
};

export const isDeviceIdleOutcome = (record: InProgressRecord): boolean => {
  const { deviceIdleEvidence, deliveryEvidence, finalProgressValue } = record;
  if (record.objectiveKind !== 'energy' || finalProgressValue === null
    || deliveryEvidence.energyIdle?.kind !== 'accepted' || !deviceIdleEvidence) return false;
  const { firstConfirmedAtMs, lastAcceptedAtMs, planningSpeedKw, permittedIdleMs } = deviceIdleEvidence;
  if (firstConfirmedAtMs === null || firstConfirmedAtMs < record.startedAtMs || permittedIdleMs <= 0
    || lastAcceptedAtMs === null || permittedIdleMs > lastAcceptedAtMs - firstConfirmedAtMs) return false;
  const closingGapMs = record.deadlineAtMs - lastAcceptedAtMs;
  if (closingGapMs < 0 || closingGapMs > MAX_CONTIGUOUS_TICK_MS) return false;
  const remainingKWh = record.targetValue - finalProgressValue;
  const lostKWh = planningSpeedKw * permittedIdleMs / HOUR_MS;
  return remainingKWh > 0 && remainingKWh <= lostKWh + DELIVERY_EPSILON_KWH
    && hasOnlyIdleRelatedBlockers(deliveryEvidence, firstConfirmedAtMs);
};
