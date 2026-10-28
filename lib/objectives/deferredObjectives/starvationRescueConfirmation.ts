import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import { scheduledHoursIncludeCurrentHour } from '../../../packages/shared-domain/src/planStarvation';

/** A reported power limit queues the confirmation even when the live rescue plan schedules this hour. */
export const canRescueRunCurrentHour = (
  estimate: DeferredObjectivePlanPreviewEstimate,
  nowMs: number,
): boolean => (
  estimate.atPowerLimitNow === undefined
  && scheduledHoursIncludeCurrentHour(estimate.scheduledHours, nowMs)
);
