/** Interpolate a countdown; its expiry never changes the authoritative state. */
import type { DeviceStatus } from '../../../contracts/src/deviceStatus.ts';
import { formatDeviceStatusReason } from '../../../shared-domain/src/deviceStatusText.ts';

type StatusDevice = { status: DeviceStatus };
type StatusPlan = { devices?: StatusDevice[] };

export const resolveDisplayPlanDeviceSnapshot = <Device extends StatusDevice>(
  device: Device, nowMs: number,
): Device => {
  const reason = device.status.reason;
  // A countdown beside the text animates only the card's ring; the text stands.
  if (reason?.countdown?.kind !== 'in_text') return device;
  // An expired countdown's reason is stale until the next status arrives; show
  // none rather than a line stuck at 0s.
  if (reason.countdown.endsAtMs <= nowMs) return { ...device, status: { ...device.status, reason: null } };
  return { ...device, status: { ...device.status,
    reason: { ...reason, text: formatDeviceStatusReason(device.status, nowMs) ?? '' } } };
};

export const planNeedsLiveUpdates = (plan: StatusPlan | null, nowMs: number): boolean => (
  plan?.devices?.some((device) => (device.status.reason?.countdown?.endsAtMs ?? 0) > nowMs) === true
);
