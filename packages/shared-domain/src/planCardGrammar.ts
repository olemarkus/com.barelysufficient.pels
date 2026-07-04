// Overview device-card state grammar (2026-07 device-state legibility pass).
//
// One grammar for all three card variants (temperature / stepped / generic):
//
//   title row      + at most ONE status chip (ladder below) + the Smart-task
//                    identity badge (a route badge, not a status — it may
//                    coexist with the one status chip)
//   state row      = bold canonical state word (PLAN_STATE_LABEL) + power fact
//   fact line      = one modality line (temperature / level), optional
//   reason line    = at most ONE exception sentence, optional
//
// Two display-state rules this module owns (the rest of the state model stays
// `resolvePlanStateKind`):
//
// 1. A hold/wait reason upgrades `idle` to `held` FOR DISPLAY: a device the
//    planner left inactive because there is no room ("Waiting to resume —
//    0.2 kW more needed") is held back, and `Idle` beside a waiting reason
//    contradicts the canon ("Idle" means PELS is NOT holding it back —
//    notes/ui-terminology.md § Device state chips).
// 2. Simulation renders the FACTUAL device state: `held`/`resuming` are
//    PELS-acted claims, and in simulation PELS acts on nothing — the bold
//    word shows what the device is actually doing (Running/Idle) and the
//    hypothetical action lives only in the reason line ("Would be limited …",
//    via `toSimulationReasonLine`). This replaces the pre-sweep card that
//    said a factual "Limited" over a hypothetical reason.
//
// Chip ladder (single status chip; losers are visible in device detail):
//   1. "Let it run now" rescue action  (releasable budget hold; suppressed in
//      simulation — there is nothing to release when PELS actuates nothing)
//   2. starvation badge (Budget limited / Low power) while the card is held
//   3. Boost (temperature or EV boost active)
//   4. Always on (budget exempt)
import { PLAN_REASON_CODES } from './planReasonSemanticsCore';
import { isOnLikeState } from './deviceStatePredicates';
import { PLAN_STATE_LABEL, resolvePlanStateKind, type PlanStateKind } from './planStateLabels';
import { formatStarvationBadge } from './planStarvation';
import type { DeviceOverviewSnapshot } from './deviceOverview';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi';

const isPlanStateKind = (value: string | undefined): value is PlanStateKind => (
  value === 'active'
  || value === 'idle'
  || value === 'held'
  || value === 'resuming'
  || value === 'manual'
  || value === 'unavailable'
  || value === 'unknown'
);

// The raw plan-state kind: the producer-resolved `stateKind` when the
// snapshot carries a valid one, else a fresh resolution. One helper so no
// card/reason call site can forget the precomputed-kind check (the sites had
// already drifted: the temperature reason resolver recomputed from scratch).
export const resolveRawPlanStateKind = (
  device: DeviceOverviewSnapshot & { stateKind?: string },
): PlanStateKind => (
  isPlanStateKind(device.stateKind) ? device.stateKind : resolvePlanStateKind(device)
);

// Reason codes that mean "PELS is holding this device back / making it wait"
// even when the planner marked it inactive rather than shed. Union of the
// stepped/temperature waiting + limited families plus the two posture holds.
const HOLD_REASON_CODES: ReadonlySet<string> = new Set([
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.shortfall,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.hourlyBudget,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.shedInvariant,
  PLAN_REASON_CODES.deferredObjectiveAvoid,
  PLAN_REASON_CODES.awaitingSolarSurplus,
  // Countdown holds that gate a resume on available power ("will try to
  // resume in Ns if power is available") — limited, not idle.
  PLAN_REASON_CODES.headroomCooldown,
  PLAN_REASON_CODES.cooldownShedding,
]);

export const isHoldReasonCode = (code: string | undefined): boolean => (
  code !== undefined && HOLD_REASON_CODES.has(code)
);

// Timed "coming back" reasons: the plan keeps the device but it is off while
// a restore/settling countdown runs ("Waiting before resuming", "Queued to
// resume — 12s", "Waiting for power meter to stabilise"). An off+keep card
// with one of these is not idle-by-choice — it reads `Resuming`.
const RESUME_WAIT_REASON_CODES: ReadonlySet<string> = new Set([
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.neutralStartupHold,
  PLAN_REASON_CODES.startupStabilization,
]);

export type IntentStateParams = {
  kind: PlanStateKind;
  reasonCode: string | undefined;
  starved: boolean;
};

// The PLAN-intent state kind: the raw kind with the idle→held upgrade. This
// is what reason resolution keys off — a hold/wait reason means the plan is
// holding the device back even when the planner marked it inactive, in real
// mode and in simulation alike (simulation only changes how the STATE WORD
// renders, not what the plan intends).
export const resolveIntentStateKind = (params: IntentStateParams): PlanStateKind => {
  const { kind, reasonCode, starved } = params;
  if (kind !== 'idle') return kind;
  // Restore/settling countdowns win over a latched starvation flag: a device
  // counting down to come back is RECOVERING (mirrors the stepped status
  // line's settling-over-starvation precedence).
  if (reasonCode !== undefined && RESUME_WAIT_REASON_CODES.has(reasonCode)) return 'resuming';
  if (starved || isHoldReasonCode(reasonCode)) return 'held';
  return kind;
};

export type DisplayStateParams = IntentStateParams & {
  dryRun: boolean;
  // The device's observed on/off state (canon: "Running" covers on, charging,
  // heating, or otherwise active — regardless of instantaneous draw).
  currentState: string | undefined;
};

// The state word the card displays (and the `data-state-kind` styling hook).
export const resolveDisplayStateKind = (params: DisplayStateParams): PlanStateKind => {
  const { dryRun, currentState } = params;
  const intentKind = resolveIntentStateKind(params);
  if (dryRun && (intentKind === 'held' || intentKind === 'resuming')) {
    // Simulation: PELS-acted kinds collapse to the factual device state; the
    // hypothetical action lives in the reason line. `not_applicable` (a
    // target-only device with no on/off axis) counts as active, matching
    // `resolvePlanStateKind`'s own active-state rule.
    const factualActive = currentState === 'not_applicable' || isOnLikeState(currentState);
    return factualActive ? 'active' : 'idle';
  }
  return intentKind;
};

export const displayStateLabel = (kind: PlanStateKind): string => PLAN_STATE_LABEL[kind];

// ─── Status chip ladder ───────────────────────────────────────────────────────

export const PLAN_CARD_BOOST_CHIP_LABEL = 'Boost';
export const PLAN_CARD_BOOST_TEMPERATURE_TOOLTIP = 'Temperature boost is active';
export const PLAN_CARD_BOOST_EV_TOOLTIP = 'EV boost is active';
export const PLAN_CARD_ALWAYS_ON_CHIP_LABEL = 'Always on';
export const PLAN_CARD_ALWAYS_ON_TOOLTIP = 'Exempt from the daily budget';

export type PlanCardStatusChip =
  // The interactive "Let it run now" two-step rescue chip (rendered by the
  // view's `BudgetExemptChip`, which owns its arm/commit state machine).
  | { type: 'rescue' }
  | { type: 'status'; label: string; tone: 'warn' | 'info' | 'ok' | 'muted'; tooltip?: string };

export type PlanCardChipParams = {
  displayKind: PlanStateKind;
  dryRun: boolean;
  starvation: SettingsUiPlanDeviceStarvation | undefined;
  // View-resolved: shouldOfferBudgetExemptCardAction && isStarvationRescuable.
  rescueEligible: boolean;
  temperatureBoostActive: boolean;
  evBoostActive: boolean;
  budgetExempt: boolean;
};

export const resolvePlanCardStatusChip = (params: PlanCardChipParams): PlanCardStatusChip | null => {
  const {
    displayKind, dryRun, starvation, rescueEligible,
    temperatureBoostActive, evBoostActive, budgetExempt,
  } = params;
  // No release action in simulation: PELS actuates nothing, so there is
  // nothing to let run — the starvation badge below still explains the state.
  if (rescueEligible && !dryRun) return { type: 'rescue' };
  // The starvation badge renders only while the card actually reads as held —
  // during the post-recovery latch window (device running again, starvation
  // still latched for diagnostics) a warn badge on a Running card would
  // contradict the state word.
  if (displayKind === 'held') {
    const badge = formatStarvationBadge(starvation);
    if (badge) return { type: 'status', label: badge.label, tone: badge.tone, tooltip: badge.tooltip };
  }
  if (temperatureBoostActive) {
    return {
      type: 'status', label: PLAN_CARD_BOOST_CHIP_LABEL, tone: 'ok', tooltip: PLAN_CARD_BOOST_TEMPERATURE_TOOLTIP,
    };
  }
  if (evBoostActive) {
    return {
      type: 'status', label: PLAN_CARD_BOOST_CHIP_LABEL, tone: 'ok', tooltip: PLAN_CARD_BOOST_EV_TOOLTIP,
    };
  }
  if (budgetExempt) {
    return {
      type: 'status', label: PLAN_CARD_ALWAYS_ON_CHIP_LABEL, tone: 'muted', tooltip: PLAN_CARD_ALWAYS_ON_TOOLTIP,
    };
  }
  return null;
};
