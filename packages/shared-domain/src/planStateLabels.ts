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
// state when no richer per-device reason is available. Since 2026-08-02 all
// three card variants reach it through the one shared ladder in
// `planCardReasonLine.ts`, so the literal is defined here and nowhere else —
// the divergence this comment used to track is gone.

// The copy for a device genuinely limited by capacity — a real `capacity` /
// limited reason code, where naming the hard cap is accurate. Kept separate from
// the held FALLBACK below: until 2026-07-25 both were one constant, so a held
// card with no known constraint borrowed this wording and asserted the hard cap
// on a house drawing 1.4 kW against a 5.4 kW pace.
//
// NOT a device-card string since 2026-08-02 — the binding ceiling is a
// house-level fact the hero states once (`notes/ui-terminology.md` § "Device
// cards say what a device needs"). This now serves `formatDeviceReasonUserFacing`
// only: the device-detail page and the runtime logs.
export const PLAN_STATE_CAPACITY_STATUS = 'Limited by the hard cap';

// Held card with no known constraint to name. It must NOT claim the hard cap:
// that is the most alarming limit PELS has and a physical one the owner cannot
// trade against (feedback_hard_cap_is_physical), and this line fires precisely
// when PELS does not know which gate is holding the device — so naming any
// specific cause is a guess. Prod 2026-07-25: a charger read "Limited by the
// hard cap" while the house drew 1.4 kW against a 5.4 kW pace.
//
// Since 2026-08-02 this is also the terminal branch of the shared card ladder
// (`resolveHeldCardReasonLine`), reached whenever a power-blocked hold carries
// no resolvable kW shortfall. It sits BELOW the starvation copy, which is more
// specific when a device has been held long enough to be flagged.
export const PLAN_STATE_HELD_FALLBACK_STATUS = 'Waiting to resume';

// Mirror status line for `dailyBudget` reason-code holds. Daily-budget pacing
// is the binding constraint instead of the hard cap. Direct attribution
// (`Limited by …`) matches `PLAN_STATE_HELD_FALLBACK_STATUS` so the two
// statuses read in the same shape.
//
// Like `PLAN_STATE_CAPACITY_STATUS`, no longer a device-card string: device
// cards state what the device needs and leave the ceiling to the hero. Serves
// `formatDeviceReasonUserFacing` — device detail and the runtime logs.
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

// Device-detail diagnostics wording for a device standing down behind another device's startup
// reservation. Kept beside its siblings (and out of the settings-UI view) so the screen and the
// runtime logs cannot drift apart. Registered in `notes/ui-terminology.md`.
export const PLAN_STATE_RESERVED_FOR_START_STATUS = 'Waiting for a scheduled device to start';

// Reason line for an opted-in device PELS is leaving off because it was turned
// off outside PELS, independently of its current plan (reason code
// `externalOffHold`). Pairs with the display-only `Off` state word, NOT
// `Limited`: PELS is not holding the device back, it is respecting an explicit
// action — so this code is deliberately absent from `HOLD_REASON_CODES` in
// `planCardGrammar.ts`. Registered in `notes/ui-terminology.md`.
export const PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS = 'Turned off elsewhere — turn it on to resume';

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

const asFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

// A target-only device (`not_applicable` — no on/off axis) that has reached its
// target and is drawing nothing is doing nothing: "Idle", not "Running".
// `not_applicable → active` is otherwise pure inference, and prod 2026-08-01
// showed its failure mode — the only card claiming "Running" was a thermostat
// at 20.8 °C against a 16 °C target at 0.0 kW, the one device with nothing to
// do. Heating semantics (temperature at/above target = satisfied) — PELS
// manages heaters, water heaters, and floor thermostats; a device actively
// drawing power never lands here (the measured gate keeps it "Running").
// Missing measurement counts as 0: an unmetered thermostat at/above target is
// not calling for heat.
//
// Satisfaction is judged against the HIGHEST target PELS knows about: the live
// `currentTarget` can be the setpoint PELS itself lowered (shed floor still on
// the device during keep-state restore windows, pending raise commands), and a
// room "satisfied" against the lowered floor is the mirror-image lie — "nothing
// to do" while suppressed. So: never classify while the observed target equals
// the shed floor or while a target command is in flight, and prefer
// `plannedTarget` when it is higher than the observed setpoint.
//
// Structural dependency: nothing here checks that `currentTarget` is a
// temperature — the comparison is safe only because producers populate
// `currentTemperature` exclusively for temperature-observed devices. If a
// producer ever widens it (e.g. a charger's internal temperature beside an
// ampere target), this predicate must learn a unit guard.
export const isSatisfiedTargetOnlyDevice = (device: DeviceOverviewSnapshot): boolean => {
  if (device.currentState !== 'not_applicable') return false;
  if (device.pendingTargetCommand) return false;
  const currentTemperature = asFiniteNumber(device.currentTemperature);
  const currentTarget = asFiniteNumber(device.currentTarget);
  if (currentTemperature === null || currentTarget === null) return false;
  if (
    device.shedAction === 'set_temperature'
    && typeof device.shedTemperature === 'number'
    && currentTarget === device.shedTemperature
  ) {
    return false;
  }
  const plannedTarget = asFiniteNumber(device.plannedTarget);
  const effectiveTarget = plannedTarget !== null ? Math.max(currentTarget, plannedTarget) : currentTarget;
  if (currentTemperature < effectiveTarget - 0.1) return false;
  return (asFiniteNumber(device.measuredPowerKw) ?? 0) <= 0.05;
};

export const resolvePlanStateKind = (device: DeviceOverviewSnapshot): PlanStateKind => {
  if (device.controllable === false) return 'manual';
  if (isGray(device)) return device.available === false ? 'unavailable' : 'unknown';
  if (device.plannedState === 'inactive') return 'idle';
  if (device.plannedState === 'shed') return 'held';
  if (device.binaryCommandPending && isOffLike(device.currentState)) return 'resuming';
  if (hasSteppedRestorePending(device)) return 'resuming';
  if (isSatisfiedTargetOnlyDevice(device)) return 'idle';
  if (isActiveState(device)) return 'active';
  if (!normalize(device.currentState)) return 'unknown';
  return 'idle';
};

export const resolvePlanStateTone = (device: DeviceOverviewSnapshot): PlanStateTone => (
  PLAN_STATE_TONE[resolvePlanStateKind(device)]
);
