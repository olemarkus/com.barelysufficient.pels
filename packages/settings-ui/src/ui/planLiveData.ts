/** Interpolate a countdown; its expiry never changes the authoritative state. */
import type { DeviceStatus } from '../../../contracts/src/deviceStatus.ts';
import { formatDeviceStatusReason } from '../../../shared-domain/src/deviceStatusText.ts';

type StatusDevice = { status: DeviceStatus };
type StatusPlan = { devices?: StatusDevice[] };

export const resolveDisplayPlanDeviceSnapshot = <Device extends StatusDevice>(
  _plan: StatusPlan | null, device: Device, _renderedAtMs: number, nowMs: number,
): Device => {
  const reason = device.status.reason;
  if (!reason?.countdown) return device;
  return { ...device, status: { ...device.status,
    reason: { ...reason, text: formatDeviceStatusReason(device.status, nowMs) ?? '' } } };
};

export const resolveDisplayPlanDevices = <Device extends StatusDevice>(
  plan: StatusPlan | null, devices: Device[], renderedAtMs: number, nowMs: number,
): Device[] => devices.map((device) => resolveDisplayPlanDeviceSnapshot(plan, device, renderedAtMs, nowMs));

export const planNeedsLiveUpdates = (plan: StatusPlan | null, _renderedAtMs: number, nowMs: number): boolean => (
  plan?.devices?.some((device) => (device.status.reason?.countdown?.endsAtMs ?? 0) > nowMs) === true
);
