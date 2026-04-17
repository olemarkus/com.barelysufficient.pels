import {
  buildComparablePlanReason,
  formatDeviceReason,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics.ts';

export const legacyDeviceReason = (reason: string | undefined): DeviceReason | undefined => (
  typeof reason === 'string' ? buildComparablePlanReason(reason) : undefined
);

export const reasonText = (reason: DeviceReason | string | undefined): string => {
  if (typeof reason === 'string') return reason;
  return reason ? formatDeviceReason(reason) : '';
};
