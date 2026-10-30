// Why a smart task is waiting or paused: the pending and exclusion reasons and
// the one-line copy each surface shares for them.
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanPendingReason,
} from '../../../contracts/src/deferredObjectiveActivePlans';

export type DeadlinePlanUnavailableReason =
  | 'no_current_reading'
  | 'direction_unavailable'
  | 'already_satisfied';

export type DeadlinePlanPendingReason =
  // Just created or just edited — the allocator has not run yet, so there is no
  // blocker to name. Also the resolved default for a record with no reason, so
  // absence can never be rendered as a specific cause.
  | 'not_yet_planned'
  | 'awaiting_horizon_plan'
  | 'price_feature_disabled'
  | 'device_data_missing'
  | 'waiting_for_car'
  // EV plugged-out / discharging session — runtime diagnostics emit
  // `objective_invalid_session`; UI surfaces it as a paused state so the user
  // knows the plan resumes once they plug back in.
  | 'invalid_session'
  // Thermal devices have no shipped bootstrap kWh/°C, so a new device sits
  // pending until the energy profile is learned from power readings.
  | 'missing_capacity'
  // The device belongs to a separately-metered home, outside smart-task scope.
  | 'device_in_sub_home'
  // "Managed by PELS" is off for the device, so PELS plans nothing for it. The
  // task is paused, not ended: it resumes when the device is managed again.
  | 'device_unmanaged';

// One-line user-facing copy for the cold-start `missing_capacity` pending
// reason. Thermal smart tasks have no shipped bootstrap kWh/°C, so a new
// heater (or any thermal device without `measure_power`) sits "Waiting"
// indefinitely until the planner has enough power samples to learn the
// energy profile. This copy tells the user what unblocks the plan. The
// thermal `missing_capacity` resolver renders it as the metaLine; the
// canonical joined form lives here so runtime log breadcrumbs can emit
// the same string (per `feedback_ui_text_shared_with_logs.md`).
export const PENDING_REASON_MISSING_CAPACITY_COPY = 'Learning energy use — needs power readings from this device.';

// The device is present and the task is intact; PELS simply is not managing the
// device, so it plans nothing for it. Named after the real switch on the device
// page ("Managed by PELS") so the remedy is findable — see
// `feedback_remedy_copy_names_real_toggle`. Shared by the widget why-line, the
// list/detail surfaces and the runtime log breadcrumb, per
// `feedback_ui_text_shared_with_logs`.
export const SMART_TASK_DEVICE_UNMANAGED_WHY = 'PELS isn’t managing this device.';
export const SMART_TASK_DEVICE_UNMANAGED_RECOURSE = 'Turn on Managed by PELS in Setup to resume this task.';

export const WAITING_FOR_CAR_ASSOCIATION = 'Waiting to identify the connected car';
/** The device card's reason once the matching window from the plug-in has closed with no car. */
export const CAR_ASSOCIATION_TIMED_OUT = 'Could not identify the connected car. '
  + 'Confirm it in the charger’s Car section.';

// EV device-card variant of the unplugged/invalid-session pause line: a card-slot phrasing with no
// terminal punctuation, promoted to a named constant so the card surface shares
// one source rather than inlining a second literal.
export const EV_PLUG_OUT_PAUSED_CARD_LINE = 'Charging paused — car unplugged';

/**
 * The one place absence of a `pendingReason` is turned into a reason. A pending
 * record can legitimately carry none — the recorder seeds it from a flow-card /
 * settings edit before any diagnostic exists, and records persisted before the
 * field shipped have none either. Both mean "no blocker is known", which is
 * exactly `not_yet_planned`.
 *
 * Every consumer must route through this instead of defaulting locally. A local
 * `?? 'awaiting_horizon_plan'` made a freshly created task assert "Waiting for
 * tomorrow's prices" on a screen that was already drawing tomorrow's prices
 * (prod 2026-07-26), and the widget's confidence-chip suppression compared the
 * raw field with no fallback at all — so the two branches disagreed about what
 * absence meant.
 */
export const resolveSmartTaskPendingReason = (
  reason: DeferredObjectiveActivePlanPendingReason | undefined,
): DeferredObjectiveActivePlanPendingReason => reason ?? 'not_yet_planned';

/**
 * The live diagnostic code outranks the persisted `pendingReason` for the two
 * durable exclusions. The recorder refreshes the code every cycle, so a device
 * that has just been relocated or un-managed says so immediately instead of
 * showing whatever blocker was current when the plan was last written.
 *
 * Producer-side and shared: the pending hero and the list chip
 * ({@link resolveSmartTaskListStatus}) must answer "which reason is this task
 * showing" the same way, and a consumer-side copy of this precedence is how the
 * two surfaces drift apart.
 */
export const resolveExclusionPendingReason = (
  diagnosticReasonCode: DeferredObjectiveActivePlanDiagnosticReason | undefined,
): DeadlinePlanPendingReason | null => {
  if (diagnosticReasonCode === 'objective_device_in_sub_home') return 'device_in_sub_home';
  if (diagnosticReasonCode === 'objective_device_unmanaged') return 'device_unmanaged';
  return null;
};

/**
 * "Is this task paused by a durable device exclusion?" — the one predicate every
 * surface that must NOT keep serving a cached schedule asks: the detail hero
 * (`resolveRenderInput`), the `deadline_status_is` Flow condition, and the list
 * chip via {@link resolveSmartTaskListStatus}.
 *
 * Reads the live diagnostic code first (refreshed every cycle, so it is right
 * even on a committed plan with a cached `latest`) and the persisted pending
 * reason second, for a task that never got a revision. Shared so that adding a
 * third exclusion cannot be remembered on one surface and forgotten on another —
 * which is exactly how the un-managed pause first shipped a "Paused" chip that
 * opened onto a green "On track" hero.
 */
export const isDeviceExclusionPaused = (plan: {
  diagnosticReasonCode?: DeferredObjectiveActivePlanDiagnosticReason;
  pendingReason?: DeferredObjectiveActivePlanPendingReason;
}): boolean => (
  resolveExclusionPendingReason(plan.diagnosticReasonCode) !== null
  || plan.pendingReason === 'device_in_sub_home'
  || plan.pendingReason === 'device_unmanaged'
);

/**
 * Pending reasons whose "why" line owns the detail row: showing the
 * "Estimating" confidence chip beside one reads as two conflicting blocked
 * states. Resolved through {@link resolveSmartTaskPendingReason} so a record
 * with no reason is judged by the same rule as one that carries it.
 */
const PENDING_REASONS_OWNING_DETAIL_ROW: ReadonlySet<DeferredObjectiveActivePlanPendingReason> = new Set([
  'not_yet_planned',
  'awaiting_horizon_plan',
]);

export const suppressesSmartTaskConfidenceChip = (
  reason: DeferredObjectiveActivePlanPendingReason | undefined,
): boolean => PENDING_REASONS_OWNING_DETAIL_ROW.has(resolveSmartTaskPendingReason(reason));

// ─── EV device-card state lines ───────────────────────────────────────────────

export type EvCardStateLine =
  | { kind: 'next_start'; text: string }
  | { kind: 'active_charging'; text: string }
  | { kind: 'plug_out_paused'; text: string }
  | { kind: 'none' };

// Resolve the most-actionable EV state line for a device card.
//
// Priority (most actionable first):
//   1. Active charging: current bucket is planned → show planned finish time.
//   2. Next planned start: a future first bucket exists → show its start time.
//   3. Plug-out paused: session is invalid (car unplugged) → static message.
//
// `isPlugOutPaused` comes from the diagnostic reason
// `objective_invalid_session`. `formatTime` is supplied by the caller (UI
// layer) so shared-domain stays free of locale/Date helpers — see the rule on
// `DeadlinePendingContext`.
export const resolveEvCardStateLine = (
  hours: ReadonlyArray<{ startsAtMs: number; endsAtMs: number; coversFromMs?: number }>,
  nowMs: number,
  isPlugOutPaused: boolean,
  formatTime: (ms: number) => string,
): EvCardStateLine => {
  // ES2020-safe last-element access (no Array#at): shared-domain is bundled
  // into the settings UI, which esbuild targets at es2020.
  const lastHour = hours[hours.length - 1];
  if (lastHour !== undefined) {
    const lastHourEndMs = lastHour.endsAtMs;
    // Active charging requires `nowMs` to fall inside one of the planned
    // hour buckets, not just between first and last. EV schedules can be
    // non-contiguous (e.g. planned hours at 01:00 and 05:00 with `now` at
    // 03:00); during a gap the card should show "Waiting · charging starts
    // HH:MM" with the next planned hour, not the active-charging line.
    const insidePlannedHour = hours.some(
      (hour) => (hour.coversFromMs ?? hour.startsAtMs) <= nowMs && hour.endsAtMs > nowMs,
    );
    if (insidePlannedHour) {
      return { kind: 'active_charging', text: `Charging · planned finish ${formatTime(lastHourEndMs)}` };
    }
    const nextHour = hours.find((hour) => hour.startsAtMs > nowMs);
    if (nextHour !== undefined) {
      return { kind: 'next_start', text: `Waiting · charging starts ${formatTime(nextHour.startsAtMs)}` };
    }
  }

  if (isPlugOutPaused) {
    return { kind: 'plug_out_paused', text: EV_PLUG_OUT_PAUSED_CARD_LINE };
  }

  return { kind: 'none' };
};
