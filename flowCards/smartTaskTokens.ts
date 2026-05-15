// Shared smart-task trigger token bag — one canonical schema and one set of
// builders consumed by all three smart-task triggers so they cannot drift.
//
// Stable-id literal values exported here form a public-API contract for flow
// authors who filter on `outcome_id`, `status_id`, `change_reason_id` etc.
// Renaming a value here is a breaking change for user flows.

import {
  formatDeadlineLocalTime,
  type DeferredObjectiveActivePlanRevisionReason,
  type DeferredObjectiveEndedEvent,
  type DeferredObjectivePlanRevisionEvent,
  type DeferredObjectiveStatusSnapshot,
} from '../lib/plan/deferredObjectives';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';

export type SmartTaskOutcomeId = 'succeeded' | 'missed' | 'abandoned';

export type SmartTaskStatusId =
  | 'waiting'
  | 'on_track'
  | 'at_risk'
  | 'unachievable'
  | 'satisfied';

export type SmartTaskChangeReasonId =
  | 'objective_changed'
  | 'prices_revised'
  | 'rate_refined'
  | 'measured_deviation';

const SMART_TASK_OUTCOME_LABELS: Record<SmartTaskOutcomeId, string> = {
  succeeded: 'Succeeded',
  missed: 'Missed',
  abandoned: 'Abandoned',
};

const SMART_TASK_STATUS_LABELS: Record<SmartTaskStatusId, string> = {
  waiting: 'Waiting',
  on_track: 'On track',
  at_risk: 'At risk',
  unachievable: 'Cannot finish',
  satisfied: 'Satisfied',
};

// `flow_card` and `prices_arrived` mark plan creation, not change — the
// deadline_plan_changed trigger never fires for them. `measured_deviation` is
// reserved until the observability work lands. The remaining three are the
// stable ids surfaced to flow authors today.
export const toSmartTaskChangeReasonId = (
  reason: DeferredObjectiveActivePlanRevisionReason,
): SmartTaskChangeReasonId | null => {
  switch (reason) {
    case 'objective_changed':
    case 'prices_revised':
    case 'rate_refined':
    case 'measured_deviation':
      return reason;
    case 'flow_card':
    case 'prices_arrived':
      return null;
    default:
      return null;
  }
};

const formatLocalTime = (atMs: number | null, timeZone: string): string => (
  atMs === null ? '' : formatDeadlineLocalTime(atMs, timeZone)
);

// Homey number-typed flow tokens must not be null. Coerce nullish or
// non-finite inputs to 0 — flows that care about "data not ready yet"
// should filter on `status_id = waiting` instead of treating 0 as a
// sentinel.
const roundForToken = (value: number | null, decimals: number): number => {
  if (!isFiniteNumber(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const composeShortfallSummary = (event: DeferredObjectiveEndedEvent): string => {
  if (event.outcome === 'succeeded') return '';
  if (event.objectiveKind === 'temperature'
    && event.targetTemperatureC !== null
    && event.finalProgressC !== null) {
    const delta = event.targetTemperatureC - event.finalProgressC;
    if (delta > 0) return ` (${delta.toFixed(1)} °C short)`;
  }
  if (event.objectiveKind === 'ev_soc'
    && event.targetPercent !== null
    && event.finalProgressPercent !== null) {
    const delta = event.targetPercent - event.finalProgressPercent;
    if (delta > 0) return ` (${delta.toFixed(0)} % short)`;
  }
  return '';
};

const composeEndedNotificationText = (event: DeferredObjectiveEndedEvent, tz: string): string => {
  const device = event.deviceName ?? event.deviceId;
  const deadline = formatDeadlineLocalTime(event.deadlineAtMs, tz);
  switch (event.outcome) {
    case 'succeeded': {
      const reached = event.metAtMs !== null ? formatDeadlineLocalTime(event.metAtMs, tz) : null;
      return reached !== null
        ? `${device} smart task succeeded at ${reached} (deadline ${deadline}).`
        : `${device} smart task succeeded (deadline ${deadline}).`;
    }
    case 'missed':
      return `${device} smart task missed deadline ${deadline}${composeShortfallSummary(event)}.`;
    case 'abandoned':
      return `${device} smart task was abandoned before deadline ${deadline}.`;
    default:
      return `${device} smart task ended.`;
  }
};

const PLAN_CHANGED_REASON_CLAUSES: Record<SmartTaskChangeReasonId, string> = {
  rate_refined: 'rate refined',
  prices_revised: 'prices revised',
  objective_changed: 'target updated',
  measured_deviation: 'observed deviation',
};

const composePlanChangedNotificationText = (
  event: DeferredObjectivePlanRevisionEvent,
  tz: string,
): string => {
  const device = event.deviceName ?? event.deviceId;
  const reasonId = toSmartTaskChangeReasonId(event.reason);
  const reasonClause = reasonId !== null ? PLAN_CHANGED_REASON_CLAUSES[reasonId] : 'plan updated';
  const remaining = Math.round(event.revision.energyNeededKWh * 100) / 100;
  if (event.projectedFinishAtMs === null) {
    return `${device} smart task replanned (${reasonClause}); ${remaining} kWh remaining.`;
  }
  const finish = formatDeadlineLocalTime(event.projectedFinishAtMs, tz);
  return `${device} smart task replanned (${reasonClause}); ${remaining} kWh, finish by ${finish}.`;
};

export const buildSmartTaskEndedTokens = (
  event: DeferredObjectiveEndedEvent,
  timeZone: string,
): Record<string, unknown> => {
  const targetValue = event.objectiveKind === 'temperature'
    ? event.targetTemperatureC
    : event.targetPercent;
  const finalProgressValue = event.objectiveKind === 'temperature'
    ? event.finalProgressC
    : event.finalProgressPercent;
  const shortfallValue = (() => {
    if (event.outcome === 'succeeded' || targetValue === null || finalProgressValue === null) {
      return event.outcome === 'succeeded' ? 0 : null;
    }
    const delta = targetValue - finalProgressValue;
    return delta > 0 ? delta : 0;
  })();
  return {
    device_name: event.deviceName ?? event.deviceId,
    outcome: SMART_TASK_OUTCOME_LABELS[event.outcome],
    outcome_id: event.outcome,
    target_value: roundForToken(targetValue, 2),
    target_text: formatEndedTargetText(event),
    final_progress_value: roundForToken(finalProgressValue, 2),
    shortfall_value: roundForToken(shortfallValue, 2),
    shortfall_text: formatEndedShortfallText(event),
    deadline_local_time: formatDeadlineLocalTime(event.deadlineAtMs, timeZone),
    finished_at_local_time: event.outcome === 'succeeded' && event.metAtMs !== null
      ? formatDeadlineLocalTime(event.metAtMs, timeZone)
      : '',
    notification_text: composeEndedNotificationText(event, timeZone),
  };
};

const formatEndedTargetText = (event: DeferredObjectiveEndedEvent): string => {
  if (event.objectiveKind === 'temperature' && event.targetTemperatureC !== null) {
    return `${event.targetTemperatureC.toFixed(1)} °C`;
  }
  if (event.objectiveKind === 'ev_soc' && event.targetPercent !== null) {
    return `${event.targetPercent.toFixed(0)} %`;
  }
  return '';
};

const formatEndedShortfallText = (event: DeferredObjectiveEndedEvent): string => {
  if (event.outcome === 'succeeded') return '';
  if (event.objectiveKind === 'temperature'
    && event.targetTemperatureC !== null
    && event.finalProgressC !== null) {
    const delta = event.targetTemperatureC - event.finalProgressC;
    if (delta > 0) return `${delta.toFixed(1)} °C below target`;
  }
  if (event.objectiveKind === 'ev_soc'
    && event.targetPercent !== null
    && event.finalProgressPercent !== null) {
    const delta = event.targetPercent - event.finalProgressPercent;
    if (delta > 0) return `${delta.toFixed(0)} % below target`;
  }
  return '';
};

export const buildSmartTaskStatusTokens = (
  snapshot: DeferredObjectiveStatusSnapshot,
  status: SmartTaskStatusId,
  timeZone: string,
): Record<string, unknown> => ({
  device_name: snapshot.deviceName ?? snapshot.deviceId,
  kind: snapshot.kind,
  status: SMART_TASK_STATUS_LABELS[status],
  status_id: status,
  target_value: roundForToken(snapshot.targetValue, 2),
  target_text: snapshot.targetText,
  deadline_local_time: snapshot.deadlineLocalTime,
  planned_start_local_time: formatLocalTime(snapshot.plannedStartAtMs, timeZone),
  planned_finish_local_time: formatLocalTime(snapshot.plannedFinishAtMs, timeZone),
  required_kwh: roundForToken(snapshot.requiredKwh, 3),
  planning_speed_kw: roundForToken(snapshot.planningSpeedKw, 3),
  estimated_duration_text: snapshot.estimatedDurationText ?? '',
  risk_reason: snapshot.riskReason ?? '',
});

export const buildSmartTaskPlanChangedTokens = (
  event: DeferredObjectivePlanRevisionEvent,
  timeZone: string,
): Record<string, unknown> => {
  const { energyNeededKWh, hours } = event.revision;
  const reasonId = toSmartTaskChangeReasonId(event.reason);
  return {
    device_name: event.deviceName ?? event.deviceId,
    kind: event.objectiveKind,
    remaining_kwh: Math.round(energyNeededKWh * 1000) / 1000,
    planned_hours: hours.length,
    projected_finish_local_time: event.projectedFinishAtMs === null
      ? ''
      : formatDeadlineLocalTime(event.projectedFinishAtMs, timeZone),
    change_reason_id: reasonId ?? '',
    notification_text: composePlanChangedNotificationText(event, timeZone),
  };
};
