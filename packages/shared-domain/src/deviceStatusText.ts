import type { DeviceStatus } from '../../contracts/src/deviceStatus.js';

export function formatDeviceStatusReason(status: DeviceStatus, nowMs: number): string | null {
  const reason = status.reason;
  if (!reason) return null;
  if (!reason.countdown || reason.countdown.kind === 'beside_text') return reason.text;
  const { endsAtMs, prefix, suffix } = reason.countdown;
  return `${prefix}${Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000))}s${suffix}`;
}
