// Shared smart-task trigger token bag. The values surfaced here are a
// public-API contract for flow authors who filter on `outcome` / `status` —
// renaming a value is a breaking change.
//
// Convention matches what other Homey apps do (Easee, Home Connect,
// myUplink, Power by the Hour): a trigger emits just the thing that
// changed. Display formatting, composed notification text, and diagnostic
// introspection live outside the token bag — flow authors compose
// messages with Logic / text concatenation, and planning detail belongs
// on device capabilities, not on trigger tokens.

import type { SmartTaskStatusNotificationId } from '../packages/shared-domain/src/deadlineLabels';
import {
  formatDeadlineLocalTime,
  type DeferredObjectiveEndedEvent,
  type DeferredObjectivePlanRevisionEvent,
  type DeferredObjectiveStatusSnapshot,
} from '../lib/plan/deferredObjectives';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';

// The status-token id set is a public-API contract for flow authors. Aliasing
// here keeps the runtime call sites readable while the single source of truth
// stays in shared-domain.
export type SmartTaskStatusId = SmartTaskStatusNotificationId;

// Homey number-typed flow tokens must not be null. Coerce nullish or
// non-finite inputs to 0 — flows that need "data not ready yet" semantics
// should filter on `status = waiting` instead of treating 0 as a sentinel.
const roundForToken = (value: number | null, decimals: number): number => {
  if (!isFiniteNumber(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const computeShortfall = (event: DeferredObjectiveEndedEvent): number => {
  if (event.outcome === 'succeeded') return 0;
  if (event.objectiveKind === 'temperature'
    && event.targetTemperatureC !== null
    && event.finalProgressC !== null) {
    const delta = event.targetTemperatureC - event.finalProgressC;
    return delta > 0 ? delta : 0;
  }
  if (event.objectiveKind === 'ev_soc'
    && event.targetPercent !== null
    && event.finalProgressPercent !== null) {
    const delta = event.targetPercent - event.finalProgressPercent;
    return delta > 0 ? delta : 0;
  }
  return 0;
};

export const buildSmartTaskEndedTokens = (
  event: DeferredObjectiveEndedEvent,
): Record<string, unknown> => ({
  device_name: event.deviceName ?? event.deviceId,
  outcome: event.outcome,
  shortfall: roundForToken(computeShortfall(event), 2),
});

export const buildSmartTaskStatusTokens = (
  snapshot: DeferredObjectiveStatusSnapshot,
  status: SmartTaskStatusId,
): Record<string, unknown> => ({
  device_name: snapshot.deviceName ?? snapshot.deviceId,
  status,
});

export const buildSmartTaskPlanChangedTokens = (
  event: DeferredObjectivePlanRevisionEvent,
  timeZone: string,
): Record<string, unknown> => ({
  device_name: event.deviceName ?? event.deviceId,
  remaining_kwh: roundForToken(event.revision.energyNeededKWh, 3),
  planned_hours: event.revision.hours.length,
  projected_finish_local_time: event.projectedFinishAtMs === null
    ? ''
    : formatDeadlineLocalTime(event.projectedFinishAtMs, timeZone),
});
