import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import { formatDeviceReasonUserFacing, PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { PLAN_STATE_AWAITING_BATTERY_LEVEL_STATUS } from '../../packages/shared-domain/src/planStateLabels';
import { isEvPlugStateCommandable } from '../../packages/shared-domain/src/evPlugState';
import {
  CAR_ASSOCIATION_SELECTED_CARS_UNPLUGGED, CAR_ASSOCIATION_TIMED_OUT, WAITING_FOR_CAR_ASSOCIATION,
} from '../../packages/shared-domain/src/smartTaskCopy/pendingReasons';
import type { DeviceStatusInput } from './deviceStatusInput';

/**
 * The small facets a device card's reason line can carry beside its text: the
 * actions it offers and a warning tone. Each reads one fact of the device.
 */
export const resolvePhaseSettingOffer = (device: DeviceStatusInput): { offersPhaseSetting?: true } => (
  device.reason.code === PLAN_REASON_CODES.phaseLimit && device.phaseFootprint?.kind === 'unknown'
    ? { offersPhaseSetting: true } : {}
);

export const resolveCarConfirmationOffer = (device: DeviceStatusInput): { offersCarConfirmation?: true } => (
  device.carIdentificationState === 'timed_out' || device.carIdentificationState === 'selected_cars_unplugged'
  || (device.carIdentificationState === 'waiting' && isWaitingForBatteryLevel(device))
    ? { offersCarConfirmation: true } : {}
);

export const isWaitingForBatteryLevel = (device: DeviceStatusInput): boolean => (
  device.reason.code === PLAN_REASON_CODES.awaitingBatteryLevel
  || (mayShowInstallationMemberHold(device) && device.chargeTargetHeld?.kind === 'awaiting_level')
);

// A shared installation’s primary can have an ordinary group posture while
// its own charging switch is held off. An explicit group reason takes precedence.
export const mayShowInstallationMemberHold = (device: DeviceStatusInput): boolean => (
  device.chargingInstallation !== undefined
  && (device.reason.code === PLAN_REASON_CODES.keep
    || (device.reason.code === PLAN_REASON_CODES.inactive && device.evChargingState !== undefined
      && isEvPlugStateCommandable(device.evChargingState)))
);

// A different device reason keeps its line. The confirmation action is still
// available where the car's matching window already closed.
export function resolveCarIdentificationReason(
  device: DeviceStatusInput, reasonText: string | null,
): DeviceStatus['reason'] {
  const state = device.carIdentificationState;
  if (state === 'not_waiting' || (reasonText !== null && reasonText !== '')) return null;
  if (state === 'timed_out') return { text: CAR_ASSOCIATION_TIMED_OUT, tone: 'warning', offersCarConfirmation: true };
  if (state === 'selected_cars_unplugged') {
    return { text: CAR_ASSOCIATION_SELECTED_CARS_UNPLUGGED, offersCarConfirmation: true };
  }
  return { text: WAITING_FOR_CAR_ASSOCIATION };
}

function buildBatteryLevelWaitReason(device: DeviceStatusInput): NonNullable<DeviceStatus['reason']> {
  const identification = resolveCarIdentificationReason(device, null);
  if (identification?.offersCarConfirmation) return identification;
  const offer = resolveCarConfirmationOffer(device);
  const text = PLAN_STATE_AWAITING_BATTERY_LEVEL_STATUS;
  if (offer.offersCarConfirmation) return { text, ...offer };
  const action = device.hasSelectedCars
    ? 'Check the car’s battery reading in Homey.'
    : 'Use the Report battery level for charger Flow card.';
  return { text: `${text}. ${action}` };
}

export function resolveBatteryTargetReason(device: DeviceStatusInput): DeviceStatus['reason'] {
  if (isWaitingForBatteryLevel(device)) return buildBatteryLevelWaitReason(device);
  if (mayShowInstallationMemberHold(device) && device.chargeTargetHeld?.kind === 'target_reached') {
    return { text: formatDeviceReasonUserFacing({
      code: PLAN_REASON_CODES.chargeTargetReached,
      targetPercent: device.chargeTargetHeld.targetPercent,
    }) };
  }
  return null;
}

/** A last-resort relay whose maximum never fits stays off until the owner corrects its setup. */
export const resolveOwnerActionTone = (device: DeviceStatusInput): { tone?: 'warning' } => (
  device.reason.code === PLAN_REASON_CODES.lastResortAboveLimit ? { tone: 'warning' } : {}
);
