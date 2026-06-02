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
  type DeferredObjectiveHoursRemainingEvent,
  type DeferredObjectivePlanRevisionWrittenEvent,
} from '../lib/objectives/deferredObjectives';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';

// The status-token id set is a public-API contract for flow authors. Aliasing
// here keeps the runtime call sites readable while the single source of truth
// stays in shared-domain.
export type SmartTaskStatusId = SmartTaskStatusNotificationId;

type SmartTaskStatusTokenSource = {
  deviceId: string;
  deviceName: string | null;
};

// Homey number-typed flow tokens must not be null. Coerce nullish or
// non-finite inputs to 0 — flows that need "data not ready yet" semantics
// should filter on `status = waiting` instead of treating 0 as a sentinel.
const roundForToken = (value: number | null, decimals: number): number => {
  if (!isFiniteNumber(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

// `known === false` flags the SDK-imposed fallback path: Homey number tokens
// cannot be null, so when the device-side delta is unobservable (target or
// final-progress sample missing) `value` collapses to 0. Flow authors should
// gate any numeric comparison on `known` so they can tell that "0" from a real
// "missed by exactly 0" outcome.
const computeShortfall = (event: DeferredObjectiveEndedEvent): {
  value: number;
  known: boolean;
} => {
  if (event.outcome === 'succeeded') return { value: 0, known: true };
  if (event.objectiveKind === 'temperature'
    && event.targetTemperatureC !== null
    && event.finalProgressC !== null) {
    const delta = event.targetTemperatureC - event.finalProgressC;
    return { value: delta > 0 ? delta : 0, known: true };
  }
  if (event.objectiveKind === 'ev_soc'
    && event.targetPercent !== null
    && event.finalProgressPercent !== null) {
    const delta = event.targetPercent - event.finalProgressPercent;
    return { value: delta > 0 ? delta : 0, known: true };
  }
  return { value: 0, known: false };
};

export const buildSmartTaskEndedTokens = (
  event: DeferredObjectiveEndedEvent,
): Record<string, unknown> => {
  const shortfall = computeShortfall(event);
  return {
    device_name: event.deviceName ?? event.deviceId,
    outcome: event.outcome,
    shortfall: roundForToken(shortfall.value, 2),
    shortfall_known: shortfall.known,
  };
};

export const buildSmartTaskStatusTokens = (
  source: SmartTaskStatusTokenSource,
  status: SmartTaskStatusId,
): Record<string, unknown> => ({
  device_name: source.deviceName ?? source.deviceId,
  status,
});

// Minimal per the token-minimalism convention (`notes/smart-task-flow-cards`):
// emit only the thing that changed. The trigger is "time remaining crossed a
// threshold", so the bag is the device name plus the remaining whole hours at
// the crossing. Status / target / diagnostic detail belong on conditions and
// device capabilities, not here.
export const buildSmartTaskHoursRemainingTokens = (
  event: DeferredObjectiveHoursRemainingEvent,
): Record<string, unknown> => ({
  device_name: event.deviceName ?? event.deviceId,
  hours_remaining: roundForToken(event.hoursRemaining, 0),
});

export const buildSmartTaskPlanChangedTokens = (
  event: DeferredObjectivePlanRevisionWrittenEvent,
  timeZone: string,
): Record<string, unknown> => ({
  device_name: event.deviceName ?? event.deviceId,
  remaining_kwh: roundForToken(event.revision.energyNeededKWh, 3),
  planned_hours: event.revision.hours.length,
  projected_finish_local_time: event.projectedFinishAtMs === null
    ? ''
    : formatDeadlineLocalTime(event.projectedFinishAtMs, timeZone),
});
