import type {
  ObservedStateOfCharge,
  EvChargingState,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUiApi';
import type {
  DeviceOverviewSnapshot, DeviceOverviewSteppedLoad,
} from '../../packages/shared-domain/src/deviceOverview';
import {
  isHoldReasonCode,
  resolveDisplayStateKind,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
} from '../../packages/shared-domain/src/planCardGrammar';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemanticsCore';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemanticsCore';
import {
  formatDeviceReasonUserFacing, resolveRestoreShortfallKw,
} from '../../packages/shared-domain/src/planReasonFormatting';
import {
  formatHourlyExhaustedLine,
  formatShortfallLine,
  resolveHeldCardReasonLine,
  resolveHeldCardReasonVerb,
} from './planCardReasonLine';
import { formatStepDisplayLabel } from '../../packages/shared-domain/src/steppedStepLabel';
import {
  EV_ROUTINE_CHARGING_LABEL, isRoutineEvChargingState,
} from '../../packages/shared-domain/src/evChargingStateLabel';
import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
  isSteppedLoadStepOff,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import {
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  type PlanStateKind,
} from '../../packages/shared-domain/src/planStateLabels';

const capitalize = (s: string): string => (
  s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`
);

// Broader than the shared `isOffLikeState` in `deviceStatePredicates.ts`:
// also treats empty / `'disappeared'` as off-for-display so the stepped card
// renders the shared `Off` state word when the device has no fresh observation. Intentionally
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

// Step ids are matched exactly, as the planner matches them: every producer of a
// reported or target step id hands over the ladder's own id, and the ladder
// rejects only exact duplicates, so `Low` and `low` are two rungs.
const findStepIndex = (profile: SteppedLoadProfile, stepId: string | null): number => (
  stepId === null ? -1 : profile.steps.findIndex((s) => s.id === stepId)
);

const findStepLabel = (profile: SteppedLoadProfile, stepId: string | null): string | null => {
  const step = getSteppedLoadStep(profile, stepId);
  return step ? formatStepDisplayLabel(step.id) : null;
};

// Powered by the planner's off rule (`isSteppedLoadStepOff`): a rung the owner
// named `Off` that draws power runs, and reads as running here too.
const isPoweredStep = (profile: SteppedLoadProfile, stepId: string | null): boolean => {
  const step = getSteppedLoadStep(profile, stepId);
  return step !== null && !isSteppedLoadStepOff(step);
};

export const isSteppedTransit = (device: {
  steppedLoad?: Pick<SteppedLoadCardState, 'commandPending'>;
}): boolean => (
  device.steppedLoad?.commandPending === true
);

const isSettlingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.cooldownRestore
  || code === PLAN_REASON_CODES.cooldownShedding
  || code === PLAN_REASON_CODES.activationBackoff
  || code === PLAN_REASON_CODES.restorePending
  || code === PLAN_REASON_CODES.neutralStartupHold
  || code === PLAN_REASON_CODES.startupStabilization
);

const resolveSteppedWaitVerb = (
  device: SteppedCardDevice,
  profile: SteppedLoadProfile,
) => resolveHeldCardReasonVerb({
  // This path IS the stepped card and takes a required `profile`, so the ladder
  // is in hand — nothing to infer.
  steppedLoadProfile: profile,
  currentState: device.currentState,
});

type SteppedDevice = SteppedCardDevice;

const isAtTargetStep = (device: SteppedDevice): boolean => {
  const reportedId = resolveCurrentStepId(device);
  return reportedId !== null && reportedId === resolveTargetStepId(device);
};

// Settling reasons that only fire while the planner is *checking headroom* for a
// possible escalation (e.g. boost wanting a higher step). Reasons in this set are
// safe to suppress when the device is already at its target step. Other settling
// reasons (cooldown_shedding, cooldown_restore, activation_backoff, restore_pending,
// startup holds) imply the planner is actively holding the device and must keep
// rendering their countdown / status text even at-target.
const isHeadroomCheckSettlingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.meterSettling
);

// ─── Status line ──────────────────────────────────────────────────────────────

const formatSec = (sec: number): string => `${Math.round(Math.max(0, sec))}s`;

// Timing and startup holds read the same on every card, from the shared
// formatter the binary and temperature cards, device detail and logs use. Only
// the restore countdown is verb-aware here: a running stepped device waits to
// increase, not to resume.
const SHARED_SETTLING_REASON_CODES: ReadonlySet<string> = new Set([
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.neutralStartupHold,
  PLAN_REASON_CODES.startupStabilization,
]);

const resolveSettlingStatusLine = (
  reason: DeviceReason,
  verb: 'resume' | 'increase',
): string | null => {
  if (reason.code === PLAN_REASON_CODES.cooldownRestore) {
    return `Waiting to ${verb} — ${formatSec(reason.remainingSec)}`;
  }
  return SHARED_SETTLING_REASON_CODES.has(reason.code) ? formatDeviceReasonUserFacing(reason) : null;
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
    return gap !== null ? formatShortfallLine(gap, 'resume', device.starvation) : null;
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
      return formatHourlyExhaustedLine('increase', device.starvation);
    }
    const gap = resolveRestoreShortfallKw(device.reason);
    return gap !== null ? formatShortfallLine(gap, 'increase', device.starvation) : null;
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

export const resolveSteppedStatusLine = (
  device: SteppedDevice,
  profile: SteppedLoadProfile,
  _nowMs: number,
  dryRun = false,
): string | null => {
  // Active-movement states win first: a held-back device commanded back up
  // (transit) or settling after a command is RECOVERING, and diagnostics keeps
  // `starvation.isStarved` latched through the 10-min clear window — so those
  // states must render their own copy rather than a hold the device is already
  // coming out of. A suppressed at-target headroom-settling latch is a recovery
  // state too, and falls through to the reason.code paths below.
  //
  // This is where the stepped card used to run its OWN starvation override,
  // which returned the budget line ahead of every reason.code framing. The hold
  // lines below now carry the starvation themselves, through the same ladder the
  // other two card variants use, so there is nothing left to preempt.
  if (isSteppedTransit(device)) return resolveTransitStatusLine(device, profile);
  if (isSettlingReason(device.reason.code)) {
    const suppressed = isHeadroomCheckSettlingReason(device.reason.code) && isAtTargetStep(device);
    if (!suppressed) {
      const verb = resolveSteppedWaitVerb(device, profile);
      return resolveSettlingStatusLine(device.reason, verb);
    }
  }
  // A RUNNING stepped device denied a step up never reaches `resolveOffStatusLine`
  // below, so this branch stays — but the sentence itself now comes from the
  // shared formatter, which the device-detail page and the logs also use.
  if (device.reason.code === PLAN_REASON_CODES.shedInvariant) {
    return formatDeviceReasonUserFacing(device.reason);
  }
  if (device.reason.code === PLAN_REASON_CODES.waitingForOtherDevices) {
    const verb = resolveSteppedWaitVerb(device, profile);
    return resolveHeldCardReasonLine({ reason: device.reason, verb });
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
  temperature?: { currentTemperature: number; plannedTarget: number };
}): string | null => {
  // The atomic facet: present iff the stepped device is also
  // temperature-observed, complete when present.
  if (!device.temperature) return null;
  const { currentTemperature, plannedTarget } = device.temperature;
  // Same `· target` grammar as the temperature card's fact line — the arrow
  // is reserved for a target CHANGE (e.g. a solar/boost lift), never the
  // routine current-vs-target pair (notes/ui-terminology.md § device cards).
  return `${currentTemperature.toFixed(1)} °C · target ${plannedTarget.toFixed(0)} °C`;
};

// ─── Fact line (2026-07 card grammar) ─────────────────────────────────────────

// The stepped card's one modality fact line: `Charging · level 6 A` for a
// routinely-charging EV, `Level 6 A` otherwise; `Level unknown` when the
// device is on with no reported step (real-evidence-only — never inferred
// from another field); null when the device is off (the bold state word
// already covers "off").
export const resolveSteppedLevelFact = (device: {
  currentState?: string;
  steppedLoad?: Pick<DeviceOverviewSteppedLoad, 'profile' | 'reportedStepId'>;
  evChargingState?: EvChargingState;
  deviceRole?: 'ev_charger';
  stateOfCharge?: ObservedStateOfCharge;
}, stateWordNamesLevel = false): string | null => {
  if (isSteppedCardOffLikeState(device.currentState)) return null;
  const { steppedLoad } = device;
  const stepId = steppedLoad?.reportedStepId ?? null;
  if (!steppedLoad || !stepId) return 'Level unknown';
  // Resting on the ladder's off rung by the planner's rule is off, which the
  // bold state word already says.
  if (isSteppedLoadOffStep(steppedLoad.profile, stepId)) return null;
  // A held device's state word already names its level ("Limited · 6 A"), and
  // the rail marks it; the fact line keeps only what they do not say.
  const levelText = stateWordNamesLevel ? null : `level ${formatStepDisplayLabel(stepId)}`;
  const isEvCharger = device.deviceRole === 'ev_charger';
  const batteryText = isEvCharger ? resolveBatteryFact(device.stateOfCharge) : null;
  const isRoutineEvCharge = isEvCharger && isRoutineEvChargingState(device.evChargingState);
  const segments = isRoutineEvCharge
    ? [EV_ROUTINE_CHARGING_LABEL, batteryText, levelText]
    : [batteryText, levelText === null ? null : capitalize(levelText)];
  const fact = segments.filter((segment): segment is string => segment !== null).join(' · ');
  return fact === '' ? null : fact;
};

/**
 * The car's battery level for the fact line, or nothing.
 *
 * This is the number an EV owner is actually asking the card for — the same slot
 * where a temperature device shows its measured value, rather than only the amps
 * PELS set.
 *
 * Shown only when the producer has a level. When it has none there is no number
 * to show and nothing to qualify — the device-detail readout says why.
 */
const resolveBatteryFact = (
  stateOfCharge: ObservedStateOfCharge | undefined,
): string | null => {
  const level = stateOfCharge?.level;
  return level?.kind === 'known' ? `${Math.round(level.percent)} %` : null;
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
 * `hasBinaryControlCapability` (`binaryControlKind.ts`) is that capability's
 * presence), so the observer always
 * resolves a concrete `on`/`off` here, never `not_applicable`.
 *
 * PELS's own commanded step is deliberately NOT consulted. For a device with
 * Power-limit control off the planner's keep path still fills `targetStepId`
 * with a powered step (`resolveSteppedKeepDesiredStepId`), so intent reads as a
 * charge command PELS never sent — which is how an idle, switched-off charger
 * came to be labelled "Waiting for car". Matrix: `notes/ev-charger-state-copy.md`.
 */

