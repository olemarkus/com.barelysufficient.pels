import type { EvChargingState, SteppedLoadProfile } from '../../contracts/src/types';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi';
import type { DeviceOverviewSnapshot } from './deviceOverview';
import {
  isHoldReasonCode,
  resolveDisplayStateKind,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
} from './planCardGrammar';
import { PLAN_REASON_CODES } from './planReasonSemanticsCore';
import type { DeviceReason } from './planReasonSemanticsCore';
import { isOnLikeState } from './deviceStatePredicates';
import { formatDeviceReasonUserFacing, resolveRestoreShortfallKw } from './planReasonFormatting';
import { formatStarvationReason } from './planStarvation';
import { formatHourlyExhaustedLine, formatShortfallLine, resolveHeldCardReasonLine } from './planCardReasonLine';
import { formatStepDisplayLabel } from './steppedStepLabel';
import {
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  type PlanStateKind,
} from './planStateLabels';

const capitalize = (s: string): string => (
  s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`
);

const isOffLikeId = (id: string | undefined): boolean => {
  const n = (id ?? '').trim().toLowerCase();
  return n === '' || n === 'off';
};

// Broader than the shared `isOffLikeState` in `deviceStatePredicates.ts`:
// also treats empty / `'disappeared'` as off-for-display so the stepped card
// renders "Off now" when the device has no fresh observation. Intentionally
// not unified — the shared predicate is the strict off-or-unknown semantic
// used elsewhere; this one is display-only.
const isSteppedCardOffLikeState = (state: string | undefined): boolean => {
  const n = (state ?? '').trim().toLowerCase();
  return n === '' || n === 'off' || n === 'unknown' || n === 'disappeared';
};

type SteppedLoadCardState = {
  reportedStepId: string | null;
  targetStepId: string | null;
  commandPending: boolean;
};

type SteppedCardDevice = DeviceOverviewSnapshot & {
  stateKind?: PlanStateKind;
  steppedLoad?: SteppedLoadCardState;
  starvation?: SettingsUiPlanDeviceStarvation;
};

const resolveCurrentStepId = (device: SteppedCardDevice): string | null => (
  device.steppedLoad?.reportedStepId ?? null
);

const resolveTargetStepId = (device: SteppedCardDevice): string | null => (
  device.steppedLoad?.targetStepId ?? null
);

const normalizeStepId = (id: string | null): string | null => (
  id === null ? null : id.toLowerCase()
);

const findStepIndex = (profile: SteppedLoadProfile, stepId: string | null): number => {
  const norm = normalizeStepId(stepId);
  return norm === null ? -1 : profile.steps.findIndex((s) => s.id.toLowerCase() === norm);
};

const findStepLabel = (profile: SteppedLoadProfile, stepId: string | null): string | null => {
  const norm = normalizeStepId(stepId);
  if (!norm) return null;
  const step = profile.steps.find((s) => s.id.toLowerCase() === norm);
  return step ? formatStepDisplayLabel(step.id) : null;
};

const isPoweredStep = (profile: SteppedLoadProfile, stepId: string | null): boolean => {
  if (!stepId || isOffLikeId(stepId)) return false;
  const norm = normalizeStepId(stepId);
  const step = profile.steps.find((s) => s.id.toLowerCase() === norm);
  return step !== undefined && step.planningPowerW > 0;
};

export const resolveSteppedActiveStepId = (
  device: SteppedCardDevice,
  profile: SteppedLoadProfile,
): string | null => {
  if (isSteppedCardOffLikeState(device.currentState)) {
    const offStep = profile.steps.find((s) => s.id.toLowerCase() === 'off');
    return offStep?.id ?? 'off';
  }
  return resolveCurrentStepId(device);
};

export const isSteppedTransit = (device: {
  steppedLoad?: Pick<SteppedLoadCardState, 'commandPending'>;
}): boolean => (
  device.steppedLoad?.commandPending === true
);

const isSettlingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.headroomCooldown
  || code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.cooldownRestore
  || code === PLAN_REASON_CODES.cooldownShedding
  || code === PLAN_REASON_CODES.activationBackoff
  || code === PLAN_REASON_CODES.restorePending
  || code === PLAN_REASON_CODES.neutralStartupHold
  || code === PLAN_REASON_CODES.startupStabilization
);

type SteppedDevice = SteppedCardDevice;

const isAtTargetStep = (device: SteppedDevice): boolean => {
  const reportedId = normalizeStepId(resolveCurrentStepId(device));
  const targetId = normalizeStepId(resolveTargetStepId(device));
  return reportedId !== null && targetId !== null && reportedId === targetId;
};

// Settling reasons that only fire while the planner is *checking headroom* for a
// possible escalation (e.g. boost wanting a higher step). Reasons in this set are
// safe to suppress when the device is already at its target step. Other settling
// reasons (cooldown_shedding, cooldown_restore, activation_backoff, restore_pending,
// startup holds) imply the planner is actively holding the device and must keep
// rendering their countdown / status text even at-target.
const isHeadroomCheckSettlingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.headroomCooldown
);

// ─── Status line ──────────────────────────────────────────────────────────────

const formatSec = (sec: number): string => `${Math.round(Math.max(0, sec))}s`;

const resolveElapsedAgoText = (countdownStartedAtMs: number | undefined, nowMs: number): string => {
  if (countdownStartedAtMs === undefined) return 'recently';
  const elapsed = Math.round((nowMs - countdownStartedAtMs) / 1000);
  return elapsed >= 0 ? `${elapsed}s ago` : 'recently';
};

const resolveSettlingStatusLine = (reason: DeviceReason, nowMs: number): string | null => {
  if (reason.code === PLAN_REASON_CODES.headroomCooldown) {
    if (reason.kind === 'recent_pels_restore') {
      const ago = resolveElapsedAgoText(reason.countdownStartedAtMs, nowMs);
      return `Resumed ${ago} — checking power reading`;
    }
    return `Limited — will try to resume in ${formatSec(reason.remainingSec)} if power is available`;
  }
  if (reason.code === PLAN_REASON_CODES.cooldownRestore) {
    const ago = resolveElapsedAgoText(reason.countdownStartedAtMs, nowMs);
    return `Resumed ${ago} — checking power reading`;
  }
  if (reason.code === PLAN_REASON_CODES.cooldownShedding) {
    return `Limited — will try to resume in ${formatSec(reason.remainingSec)} if power is available`;
  }
  if (reason.code === PLAN_REASON_CODES.meterSettling) {
    return `Waiting for power meter to stabilise — ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.activationBackoff) {
    return `Briefly holding — ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.restorePending) {
    return `Queued to resume — ${formatSec(reason.remainingSec)}`;
  }
  if (reason.code === PLAN_REASON_CODES.neutralStartupHold) {
    return 'Holding at startup';
  }
  if (reason.code === PLAN_REASON_CODES.startupStabilization) {
    return 'Stabilising after startup';
  }
  return null;
};

const resolveTransitStatusLine = (device: SteppedDevice, profile: SteppedLoadProfile): string | null => {
  const targetId = resolveTargetStepId(device);
  if (!isPoweredStep(profile, targetId)) return 'Turning off to stay below limit';
  const label = findStepLabel(profile, targetId);
  if (isSteppedCardOffLikeState(device.currentState)) {
    return label ? `Turning on to ${label}` : 'Turning on';
  }
  const currentId = resolveCurrentStepId(device);
  const currentIdx = findStepIndex(profile, currentId);
  const targetIdx = findStepIndex(profile, targetId);
  if (targetIdx > currentIdx && currentIdx >= 0) return label ? `Increasing to ${label}` : 'Increasing';
  if (targetIdx < currentIdx && currentIdx >= 0) return label ? `Reducing to ${label}` : 'Reducing';
  return null;
};

const resolveBlockedStatusLine = (device: SteppedDevice, profile: SteppedLoadProfile): string | null => {
  const targetId = resolveTargetStepId(device);
  if (!targetId || !isPoweredStep(profile, targetId)) return null;
  if (isSteppedCardOffLikeState(device.currentState)) {
    const gap = resolveRestoreShortfallKw(device.reason);
    return gap !== null ? formatShortfallLine(gap, 'resume') : null;
  }
  const currentId = resolveCurrentStepId(device);
  const currentIdx = findStepIndex(profile, currentId);
  const targetIdx = findStepIndex(profile, targetId);
  if (currentIdx >= 0 && targetIdx > currentIdx) {
    // The exhausted-hour hold deliberately carries no gap — a running device
    // denied a step-up must still get the next-hour explanation (in the
    // `increase` mood), not silence, or the one hold state with a firm time
    // recourse would be the only one the card cannot explain.
    if (device.reason.code === PLAN_REASON_CODES.hourlyBudget) {
      return formatHourlyExhaustedLine('increase');
    }
    const gap = resolveRestoreShortfallKw(device.reason);
    return gap !== null ? formatShortfallLine(gap, 'increase') : null;
  }
  return null;
};

const resolveOffStatusLine = (
  device: SteppedDevice,
  showExternalOffReason: boolean,
): string | null => {
  if (showExternalOffReason) {
    return PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS;
  }
  // Still null-able on purpose: an off device the plan is NOT holding back (no
  // hold reason, no starvation) gets no status line at all. `external_off_hold`
  // is deliberately absent from `isHoldReasonCode`, so a stale off-hold on an
  // unavailable device stays silent rather than telling the owner to flip a
  // switch PELS cannot currently observe — the `showExternalOffReason` gate
  // above owns the case where that guidance IS honest.
  if (!isHoldReasonCode(device.reason.code) && device.starvation?.isStarved !== true) return null;
  return resolveHeldCardReasonLine({ reason: device.reason, starvation: device.starvation });
};

// The producer-resolved budget starvation cause wins over every reason.code
// framing in the status line: a budget-held water heater reads "Limited to stay
// within today's budget", never the insufficient-headroom waiting copy or the
// hard-cap fallback — mirrors `resolveReasonText` on the generic card.
// Capacity-cause starvation returns null so the reason.code paths produce the
// correct "Waiting for available power" copy (the hard cap is not a remedy —
// feedback_hard_cap_is_physical). Extracted so the parent resolver stays under
// the cognitive-complexity cap.
const resolveBudgetStarvationStatus = (device: SteppedDevice): string | null => (
  device.starvation?.isStarved && device.starvation.cause === 'budget'
    ? formatStarvationReason(device.starvation)
    : null
);

export const resolveSteppedStatusLine = (
  device: SteppedDevice,
  profile: SteppedLoadProfile,
  nowMs: number,
  dryRun = false,
): string | null => {
  // Active-movement states win first: a budget-held device commanded back up
  // (transit) or settling after a command is RECOVERING, but diagnostics keeps
  // `starvation.isStarved` latched through the 10-min clear window — so the
  // budget override must NOT preempt "Turning on/increasing" / settling copy
  // during recovery. It still wins over the static reason.code fallbacks below.
  // A suppressed at-target headroom-settling latch is also a recovery state: it must
  // read neutral ("Maintaining level"), not the latched budget hold, so skip the
  // override there too (the budget line still wins over the static fallbacks below).
  let skipBudgetOverride = false;
  if (isSteppedTransit(device)) return resolveTransitStatusLine(device, profile);
  if (isSettlingReason(device.reason.code)) {
    const suppressed = isHeadroomCheckSettlingReason(device.reason.code) && isAtTargetStep(device);
    if (!suppressed) return resolveSettlingStatusLine(device.reason, nowMs);
    skipBudgetOverride = true;
  }
  if (!skipBudgetOverride) {
    const budgetStatus = resolveBudgetStarvationStatus(device);
    if (budgetStatus !== null) return budgetStatus;
  }
  // A RUNNING stepped device denied a step up never reaches `resolveOffStatusLine`
  // below, so this branch stays — but the sentence itself now comes from the
  // shared formatter, which the device-detail page and the logs also use.
  if (device.reason.code === PLAN_REASON_CODES.shedInvariant) {
    return formatDeviceReasonUserFacing(device.reason);
  }
  const blocked = resolveBlockedStatusLine(device, profile);
  if (blocked !== null) return blocked;
  if (isSteppedCardOffLikeState(device.currentState)) {
    const displayKind = resolveDisplayStateKind({
      kind: resolveRawPlanStateKind(device),
      reasonCode: device.reason.code,
      starved: device.starvation?.isStarved === true,
      dryRun,
      currentState: device.currentState,
    });
    return resolveOffStatusLine(
      device,
      shouldDisplayExternalOffReason(displayKind, device.reason.code),
    );
  }
  // Quiet steady state renders NO status line (2026-07 card grammar: the
  // reason slot is exception-only). The former "Maintaining level" filler
  // said nothing the state row + level fact don't already say.
  return null;
};

export const resolveSteppedTemperatureText = (device: {
  currentTemperature?: number;
  plannedTarget?: number;
}): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number') return null;
  if (typeof plannedTarget !== 'number') return null;
  // Same `· target` grammar as the temperature card's fact line — the arrow
  // is reserved for a target CHANGE (e.g. a solar/boost lift), never the
  // routine current-vs-target pair (notes/ui-terminology.md § device cards).
  return `${currentTemperature.toFixed(1)} °C · target ${plannedTarget.toFixed(0)} °C`;
};

export const resolveSteppedPowerText = (device: {
  measuredPowerKw?: number;
}): string | null => {
  const { measuredPowerKw } = device;
  if (typeof measuredPowerKw !== 'number') return null;
  return `${measuredPowerKw.toFixed(1)} kW`;
};

const EV_CHARGING_STATE_LABELS: Record<string, string> = {
  plugged_in_charging: 'Charging',
  plugged_in_paused: 'Paused',
  plugged_in: 'Not charging',
  plugged_in_discharging: 'Discharging',
  plugged_out: 'Unplugged',
};

/**
 * The plug state in the words users already read on the device card. Shared so a
 * car's state and its charger's state are never described differently — they are
 * observations of the same plug.
 *
 * Returns `null` for an unrecognised state rather than echoing the raw enum: a
 * capability id is not user-facing copy.
 */
export const resolveEvChargingStateLabel = (state: string | undefined): string | null => (
  state === undefined ? null : EV_CHARGING_STATE_LABELS[state] ?? null
);

// The plugged-in-idle state (`plugged_in`) upgrades to a car-attributed label
// only when the charger's own command (signal 2) says current is on offer (see
// `resolveSteppedEvExceptionLabel`).
const EV_IDLE_STATE = 'plugged_in';
const EV_IDLE_COMMANDED_LABEL = 'Waiting for car';
const EV_CAR_DISAGREES_LABEL = 'Car and charger disagree';
const EV_CAR_PAUSED_LABEL = 'Paused by the car';

// ─── Fact line (2026-07 card grammar) ─────────────────────────────────────────

// EV charging states that are the routine "it's doing its thing" case — they
// fold into the fact line beside the level. Every other EV state (Paused /
// Not charging / Waiting for car / Discharging / Unplugged) is an exception
// and renders in
// the reason slot instead (`resolveSteppedEvExceptionLabel`).
const EV_ROUTINE_STATE = 'plugged_in_charging';

// The stepped card's one modality fact line: `Charging · level 6 A` for a
// routinely-charging EV, `Level 6 A` otherwise; `Level unknown` when the
// device is on with no reported step (real-evidence-only — never inferred
// from another field); null when the device is off (the bold state word
// already covers "off").
export const resolveSteppedLevelFact = (device: {
  currentState?: string;
  steppedLoad?: SteppedLoadCardState;
  evChargingState?: EvChargingState;
  controlCapabilityId?: string;
  stateOfCharge?: { percent: number; status: string };
}): string | null => {
  if (isSteppedCardOffLikeState(device.currentState)) return null;
  const stepId = device.steppedLoad?.reportedStepId ?? null;
  if (!stepId) return 'Level unknown';
  if (isOffLikeId(stepId)) return null;
  const levelText = `level ${formatStepDisplayLabel(stepId)}`;
  const isEvCharger = device.controlCapabilityId === 'evcharger_charging';
  const batteryText = isEvCharger ? resolveBatteryFact(device.stateOfCharge) : null;
  const isRoutineEvCharge = isEvCharger
    && (device.evChargingState ?? '').trim().toLowerCase() === EV_ROUTINE_STATE;
  const segments = isRoutineEvCharge
    ? [EV_CHARGING_STATE_LABELS[EV_ROUTINE_STATE], batteryText, levelText]
    : [batteryText, capitalize(levelText)];
  return segments.filter((segment): segment is string => segment !== null).join(' · ');
};

/**
 * The car's battery level for the fact line, or nothing.
 *
 * This is the number an EV owner is actually asking the card for — the same slot
 * where a temperature device shows its measured value, rather than only the amps
 * PELS set.
 *
 * Shown ONLY for a `fresh` reading. A stale, invalid or unknown one is dropped
 * rather than qualified: the card is a glance, the qualifier costs width the
 * 320 px floor does not have, and the device-detail readout already spells out
 * `stale` / `Invalid report` for anyone who needs to know why.
 */
const resolveBatteryFact = (
  stateOfCharge: { percent: number; status: string } | undefined,
): string | null => {
  if (stateOfCharge?.status !== 'fresh') return null;
  if (!Number.isFinite(stateOfCharge.percent)) return null;
  return `${Math.round(stateOfCharge.percent)} %`;
};

/**
 * Is the charger offering current at all? This is what "waiting on the car"
 * turns on: current can only be refused if it was on offer in the first place.
 *
 * The observer's `currentState` answers exactly that, and answers it across
 * BOTH withholding axes rather than only signal 2 — it resolves to `off` when
 * the `evcharger_charging` command is false *or* when the step axis is parked
 * at a 0 W step (`resolveObservedSteppedLoadCurrentState`,
 * `lib/observer/observedState.ts`). A charger switched on at 0 A offers nothing,
 * so the car is not its holdout either; collapsing both into one `off` is the
 * behaviour this label wants, not a lossy approximation of signal 2. It is also
 * the sanctioned use of that projection, which is scoped to "reason/UI
 * rendering" and barred only from standing in as on/off CONTROL truth (the
 * shed/restore lanes read `currentOn` for that).
 *
 * Every device reaching this helper has a binary capability (the exception label
 * returns early unless the control capability is `evcharger_charging`, and
 * `hasBinaryCapability` is that capability's presence), so the observer always
 * resolves a concrete `on`/`off` here, never `not_applicable`.
 *
 * PELS's own commanded step is deliberately NOT consulted. For a device with
 * Power-limit control off the planner's keep path still fills `targetStepId`
 * with a powered step (`resolveSteppedKeepDesiredStepId`), so intent reads as a
 * charge command PELS never sent — which is how an idle, switched-off charger
 * came to be labelled "Waiting for car". Matrix: `notes/ev-charger-state-copy.md`.
 */
const isChargerCommandedOn = (currentState: string | undefined): boolean => (
  isOnLikeState(currentState)
);

// Exceptional EV states for the reason slot — null for the routine charging
// state (carried by the fact line) and for non-EV devices. The idle state
// (`plugged_in`) names the car as the holdout ("Waiting for car") only when the
// charger has been told to charge; a charger commanded off states the plain
// fact ("Not charging"), because nothing is waiting on a car that has not been
// offered any current.
//
// The claim is an observation rather than an inference, so it holds in
// simulation too and takes no `dryRun` argument: `toSimulationReasonLine`
// leaves factual device states alone by design.
export const resolveSteppedEvExceptionLabel = (device: {
  /** Observer-resolved "is current on offer": `off` when commanded off OR at a 0 W step. */
  currentState?: string;
  evChargingState?: EvChargingState;
  /** The associated car's own plug state; absent when no car is associated. */
  carChargingState?: EvChargingState;
  controlCapabilityId?: string;
}): string | null => {
  if (device.controlCapabilityId !== 'evcharger_charging') return null;
  const state = (device.evChargingState ?? '').trim().toLowerCase();
  if (state === EV_ROUTINE_STATE) return null;
  const commandedOn = isChargerCommandedOn(device.currentState);
  const carLabel = resolveEvCarExceptionLabel(device, state, commandedOn);
  if (carLabel !== null) return carLabel;
  if (state === EV_IDLE_STATE && commandedOn) return EV_IDLE_COMMANDED_LABEL;
  return EV_CHARGING_STATE_LABELS[state] ?? null;
};

/**
 * What the associated CAR adds, and only where the charger alone is ambiguous.
 *
 * The charger table already decides the idle plug on its own — commanded on →
 * `Waiting for car`, commanded off → `Not charging`. What a car adds is the two
 * contradiction readings the charger can never produce by itself, plus
 * confirmation of a pause the charger only reports as its own. Matrix of
 * record: `notes/ev-charger-state-copy.md`.
 */
const resolveEvCarExceptionLabel = (
  device: { carChargingState?: EvChargingState },
  state: string,
  commandedOn: boolean,
): string | null => {
  const carState = device.carChargingState;
  if (carState === undefined) return null;
  // The charger reports current flowing, so whatever the car believes, this is
  // the routine case and the fact line already carries it.
  if (state === EV_ROUTINE_STATE) return null;
  if (state === EV_IDLE_STATE) {
    // A charger commanded off explains the idle plug by itself, and a car that
    // still reports charging is the expected lag behind that off command rather
    // than a fault — so neither the car-holdout claim nor the contradiction is
    // made here. Both need the charger to have been told to deliver current;
    // yielding leaves the caller to state the plain fact.
    if (!commandedOn) return null;
    // Both observe the same plug. Disagreement is a real fault — a lagging car
    // app or a wrong association — and is reported rather than smoothed over.
    if (carState === EV_ROUTINE_STATE) return EV_CAR_DISAGREES_LABEL;
    // The car says it is not plugged in at all, so the association is suspect.
    // Return the plain fact rather than falling through — falling through would
    // name the car as holdout on the strength of an association the car itself
    // just contradicted.
    if (carState === 'plugged_out') return EV_CHARGING_STATE_LABELS[state] ?? null;
    return EV_IDLE_COMMANDED_LABEL;
  }
  if (state === 'plugged_in_paused') {
    // Same contradiction as the idle case, and reported for the same reason: the
    // charger says it halted while the car says current is flowing.
    if (carState === EV_ROUTINE_STATE) return EV_CAR_DISAGREES_LABEL;
    if (carState === 'plugged_in_paused') return EV_CAR_PAUSED_LABEL;
  }
  return null;
};

export { capitalize as capitalizeStepLabel };
// Re-exported for existing importers; the definition now lives in
// `steppedStepLabel.ts` so `planReasonFormatting.ts` can use it without a cycle.
export { formatStepDisplayLabel } from './steppedStepLabel';
