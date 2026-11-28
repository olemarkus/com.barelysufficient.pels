import type { DecisionCheck, DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { EvChargingState } from '../../packages/contracts/src/types';
import { isRoutineEvChargingState } from '../../packages/shared-domain/src/evChargingStateLabel';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import {
  PLAN_REASON_CODES, formatDeviceReasonUserFacing, resolveRestoreShortfallKw,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { isCeilingHoldReasonCode } from './planCardReasonLine';
import type { DevicePlanDevice } from './planTypes';

const CODE = PLAN_REASON_CODES;
const START_POWER = 'Enough power to start';
const CAR_CONNECTED = 'Car connected';
const CHARGING_ALLOWED = 'Charging allowed by PELS';

const POLICY_HOLDS = new Set<DevicePlanDevice['reason']['code']>([
  CODE.deferredObjectiveAvoid,
  CODE.deferredObjectiveWaitingForPlan,
  CODE.awaitingSolarSurplus,
  CODE.awaitingPelsStart,
  CODE.externalOffHold,
]);

const BEFORE_POWER_CHECK = new Set<DevicePlanDevice['reason']['code']>([
  ...POLICY_HOLDS,
  CODE.activationBackoff,
  CODE.awaitingBatteryLevel,
  CODE.carCurrentRangeUnavailable,
  CODE.inactive,
]);

const RESTART_WAITS = new Set<DevicePlanDevice['reason']['code']>([
  CODE.activationBackoff,
  CODE.cooldownRestore,
  CODE.cooldownShedding,
  CODE.neutralStartupHold,
  CODE.restoreThrottled,
  CODE.startupStabilization,
  CODE.waitingForOtherDevices,
  CODE.meterSettling,
  CODE.restorePending,
]);

function formatPowerCheck(reason: DevicePlanDevice['reason']): string | undefined {
  const shortfallKw = resolveRestoreShortfallKw(reason);
  if (shortfallKw === null) return undefined;
  if (reason.code === CODE.insufficientHeadroom && reason.effectiveAvailableKw === null
    && reason.availableKw >= 0
    && Math.abs(reason.availableKw - reason.needKw - reason.admissionMarginKw) < 1e-9) {
    const needed = Math.ceil(reason.needKw * 10 - 1e-9) / 10;
    const available = Math.floor(reason.availableKw * 10 + 1e-9) / 10;
    return `Needed ${needed.toFixed(1)} kW, with ${available.toFixed(1)} kW available at the last check.`;
  }
  return `${shortfallKw.toFixed(1)} kW more needed.`;
}

function powerCheck(dev: DevicePlanDevice): DecisionCheck | null {
  const { reason } = dev;
  if (reason.code === CODE.meterSilent || reason.code === CODE.meterSilentHold) {
    return { label: START_POWER, state: 'unverified', detail: 'Waiting for a new power reading.' };
  }
  if (reason.code === CODE.dailyBudget) {
    const detail = formatPowerCheck(reason);
    return { label: 'Room in the daily budget', state: 'waiting', ...(detail !== undefined && { detail }) };
  }
  if (reason.code === CODE.phaseLimit) {
    return { label: START_POWER, state: 'waiting', detail: `Waiting for room on ${reason.phase}.` };
  }
  const detail = formatPowerCheck(reason);
  if (detail !== undefined || reason.code === CODE.insufficientHeadroom) {
    return { label: START_POWER, state: 'waiting', ...(detail !== undefined && { detail }) };
  }
  return null;
}

function otherBlocker(dev: DevicePlanDevice, status: NonNullable<DeviceStatus['reason']>): DecisionCheck | null {
  const { reason } = dev;
  const { text, countdown } = status;
  if (POLICY_HOLDS.has(reason.code)) {
    return { label: CHARGING_ALLOWED, state: 'waiting', detail: formatDeviceReasonUserFacing(reason) };
  }
  if (reason.code === CODE.awaitingBatteryLevel) {
    return { label: 'Battery level known', state: 'unverified', detail: formatDeviceReasonUserFacing(reason) };
  }
  if (reason.code === CODE.carCurrentRangeUnavailable) {
    return { label: 'Charging current known', state: 'unverified', detail: formatDeviceReasonUserFacing(reason) };
  }
  if (RESTART_WAITS.has(reason.code)) {
    return { label: 'Ready to restart', state: 'waiting', ...(countdown?.kind !== 'in_text' && { detail: text }) };
  }
  if (reason.code === CODE.reservedForStart
    || ('reserveHolderName' in reason && reason.reserveHolderName !== undefined)) {
    return { label: 'Power free of other reservations', state: 'waiting', detail: text };
  }
  if (reason.code === CODE.hourlyBudget || reason.code === CODE.endOfHourDrain
    || reason.code === CODE.shortfall || isCeilingHoldReasonCode(reason.code)) {
    return { label: 'Ready to start', state: 'waiting', detail: text };
  }
  return reason.code === CODE.inactive ? commandabilityCheck(dev.commandabilityReason, text) : null;
}

function commandabilityCheck(
  reason: DevicePlanDevice['commandabilityReason'], text: string,
): DecisionCheck | null {
  if (reason === undefined || reason === 'charger_unplugged') return null;
  if (reason === 'device_unavailable') {
    return { label: 'Charger available', state: 'unverified', detail: text };
  }
  return { label: 'Charger able to start', state: 'waiting', detail: text };
}

function canExplainStart(
  dev: DevicePlanDevice, status: DeviceStatus, evChargingState: EvChargingState | undefined,
): boolean {
  return dev.isEvCharger && dev.control.commandAuthority && dev.steppedStepUpHold !== true
    && !isRoutineEvChargingState(evChargingState)
    && (status.kind !== 'unavailable' || dev.reason.code === CODE.inactive);
}

function connectionChecks(evChargingState: EvChargingState | undefined, unplugged: boolean): DecisionCheck[] {
  const connected = evChargingState === undefined ? undefined : isEvPlugStateConnected(evChargingState);
  const connection: DecisionCheck = connected === undefined
    ? { label: CAR_CONNECTED, state: 'unverified', detail: 'The charger hasn’t reported whether a car is connected.' }
    : { label: CAR_CONNECTED, state: connected ? 'met' : 'waiting', detail: 'From the charger’s latest report.' };
  // A new plug report can arrive before another meter-driven decision. Keep the
  // decision evidence alongside it when the two give different answers.
  return unplugged && connected !== false
    ? [connection, { label: 'Car connected at the last decision', state: 'waiting' }]
    : [connection];
}

/** Overview projection only. The plan supplies the start decision; plug state is an observed fact. */
export function resolveChargingStartChecks(
  dev: DevicePlanDevice,
  status: DeviceStatus,
  evChargingState: EvChargingState | undefined,
): DecisionCheck[] | undefined {
  if (status.reason === null || !canExplainStart(dev, status, evChargingState)) return undefined;

  const power = powerCheck(dev);
  const blocker = power === null ? otherBlocker(dev, status.reason) : null;
  const unplugged = dev.reason.code === CODE.inactive && dev.commandabilityReason === 'charger_unplugged';
  if (power === null && blocker === null && !unplugged) return undefined;

  // Only a reached direct power check attests the preceding permission.
  const allowed = dev.reason.code === CODE.insufficientHeadroom && dev.commandableNow;
  const powerDecision = power ?? (BEFORE_POWER_CHECK.has(dev.reason.code)
    ? { label: START_POWER, state: 'not_checked' as const }
    : null);
  return [
    ...connectionChecks(evChargingState, unplugged),
    ...(allowed ? [{ label: CHARGING_ALLOWED, state: 'met' as const }] : []),
    ...(blocker === null ? [] : [blocker]),
    ...(powerDecision === null ? [] : [powerDecision]),
  ];
}
