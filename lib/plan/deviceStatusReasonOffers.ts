import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
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
    ? { offersCarConfirmation: true } : {}
);

/** A last-resort relay whose maximum never fits stays off until the owner corrects its setup. */
export const resolveOwnerActionTone = (device: DeviceStatusInput): { tone?: 'warning' } => (
  device.reason.code === PLAN_REASON_CODES.lastResortAboveLimit ? { tone: 'warning' } : {}
);
