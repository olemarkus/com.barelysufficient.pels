import { PLAN_REASON_CODES } from './planReasonSemanticsCore';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_STATUS,
  resolvePlanStateKind,
} from './planStateLabels';
import { formatStarvationReason } from './planStarvation';
import {
  DEVICE_OVERVIEW_LOWERED_BY_PELS,
  DEVICE_OVERVIEW_WOULD_LOWER,
} from './deviceOverviewStrings';
import { toSimulationReasonLine } from './simulationReasonMood';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi';
import type { DeviceOverviewSnapshot } from './deviceOverview';

type TemperatureDevice = DeviceOverviewSnapshot & {
  measuredPowerKw?: number;
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

const isWaitingReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.insufficientHeadroom
  || code === PLAN_REASON_CODES.shortfall
  || code === PLAN_REASON_CODES.headroomCooldown
  || code === PLAN_REASON_CODES.cooldownRestore
  || code === PLAN_REASON_CODES.cooldownShedding
  || code === PLAN_REASON_CODES.meterSettling
  || code === PLAN_REASON_CODES.activationBackoff
  || code === PLAN_REASON_CODES.restorePending
  || code === PLAN_REASON_CODES.waitingForOtherDevices
  || code === PLAN_REASON_CODES.neutralStartupHold
  || code === PLAN_REASON_CODES.startupStabilization
);

const isLimitedReason = (code: string): boolean => (
  code === PLAN_REASON_CODES.capacity
  || code === PLAN_REASON_CODES.hourlyBudget
  || code === PLAN_REASON_CODES.dailyBudget
  || code === PLAN_REASON_CODES.swappedOut
  || code === PLAN_REASON_CODES.swapPending
);

// ─── Output state ─────────────────────────────────────────────────────────────

export const resolveTemperatureOutputState = (device: TemperatureDevice): string => {
  const state = (device.currentState ?? '').trim().toLowerCase();
  if (!state || state === 'off' || state === 'unknown' || state === 'disappeared') return 'Off';
  return 'On';
};

// ─── Temperature line ─────────────────────────────────────────────────────────

export const resolveTemperatureLine = (device: TemperatureDevice): string | null => {
  const { currentTemperature, currentTarget, plannedTarget } = device;
  if (typeof plannedTarget !== 'number') return null;
  const targetText = typeof currentTarget === 'number' && currentTarget !== plannedTarget
    ? `${currentTarget.toFixed(0)} °C → ${plannedTarget.toFixed(0)} °C`
    : `${plannedTarget.toFixed(0)} °C`;
  // Middle-dot separator for the data line — em-dash is reserved for status
  // copy (see notes/ui-terminology.md:9). Source: TODO #8.
  if (typeof currentTemperature !== 'number') return `target ${targetText} · sensor unavailable`;
  return `${currentTemperature.toFixed(1)} °C · target ${targetText}`;
};

// ─── Reason line ─────────────────────────────────────────────────────────────

const resolveHeadroomGapKw = (reason: unknown): number | null => {
  if (!reason || typeof reason !== 'object') return null;
  const r = reason as Record<string, unknown>;
  const code = r['code'];
  if (code === PLAN_REASON_CODES.insufficientHeadroom) {
    const avail = (r['effectiveAvailableKw'] ?? r['availableKw'] ?? 0) as number;
    const need = (r['needKw'] ?? 0) as number;
    const gap = need - avail;
    return gap > 0.01 ? gap : null;
  }
  if (code === PLAN_REASON_CODES.shortfall) {
    const need = (r['needKw'] ?? 0) as number;
    const avail = (r['headroomKw'] ?? 0) as number;
    const gap = need - avail;
    return gap > 0.01 ? gap : null;
  }
  return null;
};

const resolveWaitingText = (reason: unknown): string => {
  const gap = resolveHeadroomGapKw(reason);
  return gap !== null ? `Waiting to resume — ${gap.toFixed(1)} kW more needed` : 'Waiting for available power';
};

// Map a reason code to its limited-status label. Extracted so the parent
// resolver stays under the SonarJS / ESLint complexity caps after the
// deferred-objective avoid branch was added.
const resolveLimitedReasonLabel = (reasonCode: string): string | null => {
  if (reasonCode === PLAN_REASON_CODES.deferredObjectiveAvoid) return PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS;
  if (reasonCode === PLAN_REASON_CODES.dailyBudget) return PLAN_STATE_DAILY_BUDGET_STATUS;
  if (reasonCode === PLAN_REASON_CODES.hourlyBudget) return PLAN_STATE_HOURLY_BUDGET_STATUS;
  if (isLimitedReason(reasonCode)) return PLAN_STATE_HELD_FALLBACK_STATUS;
  return null;
};

// The producer-resolved budget starvation cause wins over any reason.code
// framing: a budget-held device reads "Limited to stay within today's budget",
// never the insufficient-headroom waiting copy or the hard-cap fallback —
// mirrors `resolveReasonText` on the generic card. Capacity-cause starvation
// returns null here so the reason.code paths produce the correct "Waiting for
// available power" copy (the hard cap is physical — feedback_hard_cap_is_physical).
// Extracted so the parent resolver stays under the complexity caps.
const resolveBudgetStarvationReason = (device: TemperatureDevice): string | null => (
  device.starvation?.isStarved && device.starvation.cause === 'budget'
    ? formatStarvationReason(device.starvation)
    : null
);

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

// `dryRun` (simulation mode) switches the held device's fact-stated action
// ("Lowered by PELS") to its hypothetical variant so the card never claims PELS
// acted when it did not (notes/overview-hero-spec.md § "Simulation mode is
// hypothetical").
const resolveHeldTemperatureActionLabel = (dryRun: boolean): string => (
  dryRun ? DEVICE_OVERVIEW_WOULD_LOWER : DEVICE_OVERVIEW_LOWERED_BY_PELS
);

export const resolveTemperatureReasonLine = (
  device: TemperatureDevice,
  dryRun = false,
): string | null => {
  const { currentTemperature, plannedTarget } = device;
  if (typeof currentTemperature !== 'number' || typeof plannedTarget !== 'number') return null;

  const reasonCode = (device.reason as { code?: string } | undefined)?.code ?? '';
  const kind = resolvePlanStateKind(device);

  const surplusReason = resolveSurplusAbsorbReason(device, kind);
  if (surplusReason !== null) return surplusReason;

  if (kind !== 'held' && kind !== 'idle' && kind !== 'resuming') return null;
  if (kind === 'idle') return null;
  if (kind === 'resuming') return 'Resuming';
  const budgetReason = resolveBudgetStarvationReason(device);
  if (budgetReason !== null) return toSimulationReasonLine(budgetReason, dryRun);
  if (isWaitingReason(reasonCode)) return resolveWaitingText(device.reason);
  const limitedLabel = resolveLimitedReasonLabel(reasonCode);
  if (limitedLabel !== null) return toSimulationReasonLine(limitedLabel, dryRun);
  // `kind` is necessarily 'held' here (idle/resuming/other returned above), so
  // the held device's action reads hypothetically in simulation mode.
  return resolveHeldTemperatureActionLabel(dryRun);
};
