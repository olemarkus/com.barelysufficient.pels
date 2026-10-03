import type {
  TaskDeliveryCause, TaskDeliveryEvidence, TaskDeliveryExplanation,
} from '../../contracts/src/taskDelivery';
import { isFiniteNumber } from './numberGuards';
const CAUSES: Record<TaskDeliveryCause, true> = {
  capacity_limited: true, budget_limited: true, priority_limited: true,
  device_not_accepting: true, device_limit: true, device_schedule: true, control_pending: true,
  control_failed: true, uncontrolled: true, observation_unavailable: true,
  progress_unavailable: true, rate_insufficient: true, estimate_uncertain: true,
  delivery_unfulfilled: true, legacy_unrecorded: true,
};
const isCause = (value: unknown): value is TaskDeliveryCause => (
  typeof value === 'string' && Object.hasOwn(CAUSES, value)
);
export const isTaskDeliveryExplanation = (raw: unknown): raw is TaskDeliveryExplanation => {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  if (value.kind === 'legacy_unrecorded') return true;
  if (value.kind !== 'recorded' || !value.primary || typeof value.primary !== 'object') return false;
  const primary = value.primary as Record<string, unknown>;
  return (primary.kind === 'clear' || (primary.kind === 'blocked' && isCause(primary.cause)))
    && Array.isArray(value.contributors) && value.contributors.every(isCause)
    && Array.isArray(value.intervals) && value.intervals.every((interval: unknown) => {
      if (!interval || typeof interval !== 'object') return false;
      const item = interval as Record<string, unknown>;
      return isFiniteNumber(item.fromMs) && isFiniteNumber(item.toMs)
        && item.toMs >= item.fromMs && isCause(item.cause);
    });
};
export const isTaskDeliveryEvidence = (raw: unknown): raw is TaskDeliveryEvidence => {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  if (!isTaskDeliveryExplanation(value.explanation) || !value.nonDelivery || typeof value.nonDelivery !== 'object') {
    return false;
  }
  const state = value.nonDelivery as Record<string, unknown>;
  return state.kind === 'none'
    || ((state.kind === 'watching' || state.kind === 'confirmed') && isFiniteNumber(state.sinceMs));
};
