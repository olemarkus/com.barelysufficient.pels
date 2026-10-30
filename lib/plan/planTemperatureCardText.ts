import {
  resolveDisplayStateKind,
  resolveIntentStateKind,
  resolveRawPlanStateKind,
  shouldDisplayExternalOffReason,
} from '../../packages/shared-domain/src/planCardGrammar';
import {
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  type PlanStateKind,
} from '../../packages/shared-domain/src/planStateLabels';
import { resolveHeldCardReasonLine } from './planCardReasonLine';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUi/plan';
import type { DeviceOverviewSnapshot } from '../../packages/contracts/src/deviceOverview';
import type { IdleClassification } from '../../packages/contracts/src/idleClassification';
import type { PriceTargetShift } from '../../packages/planner-types/src/temperatureSetpoints';

type TemperatureDevice = DeviceOverviewSnapshot & {
  stateKind?: PlanStateKind;
  starvation?: SettingsUiPlanDeviceStarvation;
  priceTargetShift: PriceTargetShift;
  /** The observer's diagnosis of a device not drawing, when it has one. */
  idleClassification?: IdleClassification;
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

// A surplus run is a benign, user-opted-in posture — surface it ONLY while the
// device is actively running (`kind === 'active'`), mirroring
// `resolveSurplusAbsorbReason` below: the claim "PELS turned this on to use your
// solar" must never sit on an off/held/manual/unavailable card.
//
// Serves BOTH non-temperature modalities. The name is historical (the dump load
// came first) but the question it asks — is a surplus posture the reason this
// device is running right now — is the same for a stepped device tracking its
// surplus, and `surplusAbsorbActive` is set for both. A tracking device is only
// stamped active while parked above its off rung, so a device waiting for sun
// falls through to the hold reason instead, exactly as a dump load does.
export const resolveBinarySurplusReasonLine = (
  device: Pick<DeviceOverviewSnapshot, 'surplusAbsorbActive'>,
  kind: string,
): string | null => (
  device.surplusAbsorbActive === true && kind === 'active'
    ? BINARY_SURPLUS_ACTIVE_REASON
    : null
);

// ─── Temperature line ─────────────────────────────────────────────────────────

const resolveTemperatureTargetText = (temperature: NonNullable<TemperatureDevice['temperature']>): string => (
  temperature.currentTarget !== temperature.plannedTarget
    ? `${temperature.currentTarget.toFixed(0)} °C → ${temperature.plannedTarget.toFixed(0)} °C`
    : `${temperature.plannedTarget.toFixed(0)} °C`
);

export const resolveTemperatureLine = (device: TemperatureDevice): string | null => {
  // The atomic facet is complete when present, so the line either renders in
  // full or not at all — the old "sensor unavailable" partial state is
  // unrepresentable (a device without a sensor reading has no facet and is not
  // a temperature card).
  if (!device.temperature) return null;
  const targetText = resolveTemperatureTargetText(device.temperature);
  // Middle-dot separator for the data line — em-dash is reserved for status
  // copy (see notes/ui-terminology.md § "Core principle").
  return `${device.temperature.currentTemperature.toFixed(1)} °C · target ${targetText}`;
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

/**
 * Why the target sits off the mode's own while a price level moves it: the
 * card shows 25 °C above a mode row saying 21 °C during a cheap hour, and this
 * is the line that connects them. Running, or idle at that target with its
 * output on; a held card says what holds it, and an Off card says nothing about
 * a target. The device's own diagnosis wins: "Not drawing power" or a setpoint
 * cap is what the owner needs to read in exactly these hours, since a cheap-hour
 * raise above a heater's own cap is what produces the cap. `raised` and
 * `lowered` are the target's own number, so a cooling unit on a cheap hour reads
 * "Lowered while power is cheap".
 */
export const resolvePriceTargetReason = (
  device: Pick<TemperatureDevice, 'priceTargetShift' | 'currentState' | 'idleClassification'>,
  kind: string,
): string | null => {
  const shift = device.priceTargetShift;
  if (shift.kind !== 'shifted') return null;
  if (device.idleClassification !== undefined && device.idleClassification !== 'near_target_idle') return null;
  if (kind !== 'active' && (kind !== 'idle' || device.currentState === 'off')) return null;
  return `${shift.direction === 'raised' ? 'Raised' : 'Lowered'} while power is ${shift.priceLevel}`;
};

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
): string => resolveHeldCardReasonLine(device.reason, device.starvation);

const resolveTemperaturePlanReasonLine = (device: TemperatureDevice): string | null => {
  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolveTemperatureIntentKind(device, reasonCode);

  // A temperature card can be binary-commanded while retaining observational
  // temperature facts. It deliberately has no planned temperature, so answer
  // before the temperature-evidence gate below.
  if (kind === 'held' && device.shedAction === 'turn_off') return resolveHeldLine(device);

  if (!device.temperature) return null;

  const surplusReason = resolveSurplusAbsorbReason(device, kind);
  if (surplusReason !== null) return surplusReason;
  const priceReason = resolvePriceTargetReason(device, kind);
  if (priceReason !== null) return priceReason;

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
