import type { DeviceOverviewSnapshot } from './deviceOverview';

export type PlanStateKind =
  | 'active'
  | 'idle'
  | 'held'
  | 'resuming'
  | 'manual'
  | 'unavailable'
  | 'unknown';

export type PlanStateTone =
  | 'active'
  | 'idle'
  | 'held'
  | 'resuming'
  | 'neutral'
  | 'warning';

export const PLAN_STATE_LABEL: Record<PlanStateKind, string> = {
  active: 'Running',
  idle: 'Idle',
  held: 'Limited',
  resuming: 'Resuming',
  manual: 'Manual',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

export const PLAN_STATE_TONE: Record<PlanStateKind, PlanStateTone> = {
  active: 'active',
  idle: 'idle',
  held: 'held',
  resuming: 'resuming',
  manual: 'neutral',
  unavailable: 'warning',
  unknown: 'neutral',
};

// Fallback status line for plan-card / stepped-load devices in the `held`
// state when no richer per-device reason is available. Settings-UI consumers
// (`PlanSteppedCard.tsx`, `PlanDeviceCards.tsx`) import this constant; the
// three shared-domain reason helpers (`planSteppedCardText.ts`,
// `planTemperatureCardText.ts`, `planReasonFormatting.ts`) still inline the
// same literal — consolidating those three onto this constant alongside a
// richer `resolveReportedLoadAfterPauseText` helper is tracked in `TODO.md`
// under the P2 "Overview device-card status copy" item. Rule 4 (UI text
// shared with logs) holds because the values match across all five sites.
// The copy for a device genuinely limited by capacity — a real `capacity` /
// limited reason code, where naming the hard cap is accurate. Kept separate from
// the held FALLBACK below: until 2026-07-25 both were one constant, so a held
// card with no known constraint borrowed this wording and asserted the hard cap
// on a house drawing 1.4 kW against a 5.4 kW pace.
export const PLAN_STATE_CAPACITY_STATUS = 'Limited by the hard cap';

// Held card with no known constraint to name. It must NOT claim the hard cap:
// that is the most alarming limit PELS has and a physical one the owner cannot
// trade against (feedback_hard_cap_is_physical), and this line fires precisely
// when PELS does not know which gate is holding the device — so naming any
// specific cause is a guess. Prod 2026-07-25: a charger read "Limited by the
// hard cap" while the house drew 1.4 kW against a 5.4 kW pace. `PlanDeviceCards`
// already routes every STARVED device to `formatStarvationReason` to avoid this
// line for the two causes it does know; this is the honest text for the rest.
export const PLAN_STATE_HELD_FALLBACK_STATUS = 'Waiting to resume';

// Mirror status line for `dailyBudget` reason-code holds. Daily-budget pacing
// is the binding constraint instead of the hard cap. Direct attribution
// (`Limited by …`) matches `PLAN_STATE_HELD_FALLBACK_STATUS` so the two
// statuses read in the same shape.
export const PLAN_STATE_DAILY_BUDGET_STATUS = "Limited by today's daily budget";

// Sibling status for `hourlyBudget` holds: the planner is holding the device
// back because the current hour is close to the hard cap. Different from
// `PLAN_STATE_HELD_FALLBACK_STATUS` (a generic capacity shed) — this surface
// names the hour rather than the cap directly because the precise trigger is
// "approaching" not "at" the cap.
export const PLAN_STATE_HOURLY_BUDGET_STATUS = 'Limited — this hour is near the hard cap';

// Status line for devices held because the smart task is between planned hours
// (the current hour was relatively expensive so the load was booked into cheaper
// hours, or the task has not started yet, or it has already finished). The
// smart-task framing wins over capacity/daily framing
// when both apply because the user opted into the price-aware plan and that's
// the intent being honoured. Set by `normalizeShedReasons` in
// `lib/plan/planReasons.ts` from the deferred-objective admission decisions.
export const PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS = 'Waiting for cheaper hours';

// Status line for a binary dump load held off by its opted-in "Run on solar
// surplus" posture (reason code `awaitingSolarSurplus`). The device's baseline
// is OFF; PELS turns it on only while the home exports enough solar to cover
// its draw. Registered in `notes/ui-terminology.md` § "Solar surplus vocabulary".
export const PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS = 'Waiting for solar surplus';

const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

const isOffLike = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  return normalized === 'off' || normalized === 'unknown';
};

const isOnLike = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  if (!normalized) return false;
  return normalized !== 'off'
    && normalized !== 'unknown'
    && normalized !== 'not_applicable'
    && normalized !== 'disappeared';
};

const isGray = (device: DeviceOverviewSnapshot): boolean => {
  if (device.available === false) return true;
  if (device.observationStale === true) return true;
  const normalized = normalize(device.currentState);
  return normalized === 'unknown' || normalized === 'disappeared';
};

const hasSteppedRestorePending = (device: DeviceOverviewSnapshot): boolean => (
  // A distinct selected→desired step id pair only ever exists on a stepped device,
  // so the step-id check below already gates stepped-ness — no need to also read the
  // `controlModel` setting (which a plan device no longer carries; only stepped
  // devices populate `selectedStepId`/`desiredStepId`).
  isOffLike(device.currentState)
  && Boolean(device.selectedStepId && device.desiredStepId && device.selectedStepId !== device.desiredStepId)
);

const isActiveState = (device: DeviceOverviewSnapshot): boolean => (
  device.currentState === 'not_applicable' || isOnLike(device.currentState)
);

export const resolvePlanStateKind = (device: DeviceOverviewSnapshot): PlanStateKind => {
  if (device.controllable === false) return 'manual';
  if (isGray(device)) return device.available === false ? 'unavailable' : 'unknown';
  if (device.plannedState === 'inactive') return 'idle';
  if (device.plannedState === 'shed') return 'held';
  if (device.binaryCommandPending && isOffLike(device.currentState)) return 'resuming';
  if (hasSteppedRestorePending(device)) return 'resuming';
  if (isActiveState(device)) return 'active';
  if (!normalize(device.currentState)) return 'unknown';
  return 'idle';
};

export const resolvePlanStateTone = (device: DeviceOverviewSnapshot): PlanStateTone => (
  PLAN_STATE_TONE[resolvePlanStateKind(device)]
);
