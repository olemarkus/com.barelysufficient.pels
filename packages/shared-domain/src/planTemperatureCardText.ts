import {
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
} from './planCardGrammar';
import {
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  type PlanStateKind,
} from './planStateLabels';
import { resolveHeldCardReasonLine } from './planCardReasonLine';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi';
import type { DeviceOverviewSnapshot } from './deviceOverview';

type TemperatureDevice = DeviceOverviewSnapshot & {
  stateKind?: PlanStateKind;
  currentTemperature?: number;
  currentTarget?: unknown;
  plannedTarget?: number;
  starvation?: SettingsUiPlanDeviceStarvation;
};

// Shown when a surplus-absorb lift raised this device's setpoint to self-consume solar
// export — explains why the room is warmer than the user's own target. Plain language
// (no "self-consume"/"export" jargon); consistent with the "Use solar surplus" control.
export const TEMPERATURE_SURPLUS_REASON = 'Raised to use your solar power';

// Binary sibling of TEMPERATURE_SURPLUS_REASON: shown on a "Run on solar surplus"
// dump load's card while PELS has turned it ON to soak exported solar. The held
// counterpart ("Waiting for solar surplus") renders through the reason pipeline
// (`awaitingSolarSurplus` → PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS); only the
// active line needs a dedicated string because an active device carries no hold
// reason. Kept in this module (the surplus card-text family) per the PR-7 ruling —
// no separate binary card-text module.
export const BINARY_SURPLUS_ACTIVE_REASON = 'On to use your solar power';

// A dump-load surplus run is a benign, user-opted-in posture — surface it ONLY while
// the device is actively running (`kind === 'active'`), mirroring
// `resolveSurplusAbsorbReason` below: the claim "PELS turned this on to use your
// solar" must never sit on an off/held/manual/unavailable card.
export const resolveBinarySurplusReasonLine = (
  device: Pick<DeviceOverviewSnapshot, 'surplusAbsorbActive'>,
  kind: string,
): string | null => (
  device.surplusAbsorbActive === true && kind === 'active'
    ? BINARY_SURPLUS_ACTIVE_REASON
    : null
);

// ─── Temperature line ─────────────────────────────────────────────────────────

const resolveTemperatureTargetText = (device: TemperatureDevice): string | null => {
  const { currentTarget, plannedTarget } = device;
  const hasCurrentTarget = typeof currentTarget === 'number' && Number.isFinite(currentTarget);
  const hasPlannedTarget = typeof plannedTarget === 'number' && Number.isFinite(plannedTarget);
  if (!hasPlannedTarget) {
    return hasCurrentTarget ? `${currentTarget.toFixed(0)} °C` : null;
  }
  return hasCurrentTarget && currentTarget !== plannedTarget
    ? `${currentTarget.toFixed(0)} °C → ${plannedTarget.toFixed(0)} °C`
    : `${plannedTarget.toFixed(0)} °C`;
};

export const resolveTemperatureLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature } = device;
  const targetText = resolveTemperatureTargetText(device);
  if (targetText === null) return null;
  // Middle-dot separator for the data line — em-dash is reserved for status
  // copy (see notes/ui-terminology.md:9). Source: TODO #8.
  if (typeof currentTemperature !== 'number' || !Number.isFinite(currentTemperature)) {
    return `target ${targetText} · sensor unavailable`;
  }
  return `${currentTemperature.toFixed(1)} °C · target ${targetText}`;
};

// ─── Reason line ─────────────────────────────────────────────────────────────
//
// The held-card line itself lives in `planCardReasonLine.ts`, shared with the
// stepped and generic cards. This module only decides WHEN a temperature card
// shows one (the intent-kind and temperature-evidence gates below).

// A surplus-absorb raise is a benign, user-opted-in boost — surface it ONLY while the device
// is actively running (`kind === 'active'`), the one state where "PELS is running this hotter
// to use your solar" is true. Gating on `active` (rather than excluding held/resuming) keeps
// the line off an off/idle, manual (uncontrolled), or unavailable (offline) card, where the
// claim would contradict the visible "Off · 0.0 kW" state. Extracted so the parent resolver
// stays under the SonarJS / ESLint complexity caps.
const resolveSurplusAbsorbReason = (device: TemperatureDevice, kind: string): string | null => (
  device.surplusAbsorbActive === true && kind === 'active'
    ? TEMPERATURE_SURPLUS_REASON
    : null
);

// Plan-INTENT kind (raw + the idle→held upgrade): a hold/wait reason means
// the plan is holding the device back even when the planner marked it
// inactive, so the reason line renders for those cards too. Simulation only
// changes the state word, never whether the reason renders. Extracted so the
// parent resolver stays under the complexity cap.
const resolveTemperatureIntentKind = (device: TemperatureDevice, reasonCode: string) => (
  resolveIntentStateKind({
    // Same precomputed-kind check as the card views (resolveRawPlanStateKind)
    // so the reason line can never desync from the displayed state word on a
    // snapshot that already carries a producer-resolved `stateKind`.
    kind: resolveRawPlanStateKind(device),
    reasonCode,
    starved: device.starvation?.isStarved === true,
  })
);

const resolveHeldLine = (
  device: TemperatureDevice,
): string => resolveHeldCardReasonLine({ reason: device.reason, starvation: device.starvation });

const resolveTemperaturePlanReasonLine = (device: TemperatureDevice): string | null => {
  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolveTemperatureIntentKind(device, reasonCode);

  // A temperature card can be binary-commanded while retaining observational
  // temperature facts. It deliberately has no planned temperature, so answer
  // before the temperature-evidence gate below.
  if (kind === 'held' && device.shedAction === 'turn_off') return resolveHeldLine(device);

  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number' || typeof plannedTarget !== 'number') return null;

  const surplusReason = resolveSurplusAbsorbReason(device, kind);
  if (surplusReason !== null) return surplusReason;

  if (kind !== 'held' && kind !== 'resuming') return null;
  // The card's bold state word already says "Resuming" (2026-07 card
  // grammar) — a reason line repeating it was pure duplication.
  if (kind === 'resuming') return null;
  return resolveHeldLine(device);
};

// This reason explains a binary OFF fact rather than a temperature decision,
// so it must survive even when temperature evidence is absent. Generic cards
// already format the same reason through `formatDeviceReasonUserFacing`;
// keeping it here gives temperature cards the same one-line explanation.
export const resolveTemperatureReasonLine = (
  device: TemperatureDevice,
  dryRun = false,
): string | null => {
  const reasonCode = (device.reason as { code?: string } | undefined)?.code;
  const displayKind = resolveDisplayStateKind({
    kind: resolveRawPlanStateKind(device),
    reasonCode,
    starved: device.starvation?.isStarved === true,
    dryRun,
    currentState: device.currentState,
  });
  return shouldDisplayExternalOffReason(displayKind, reasonCode)
    ? PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS
    : resolveTemperaturePlanReasonLine(device);
};
