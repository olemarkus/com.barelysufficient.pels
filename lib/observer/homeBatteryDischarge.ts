import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';

export const readFreshHomeBatteryDischargeW = (devices: readonly DeviceSurfaces[], nowMs: number): number => (
  devices.reduce((dischargeW, { available, batteryPower }) => {
    if (!available || !batteryPower) return dischargeW;
    const ageMs = nowMs - batteryPower.observedAtMs;
    if (ageMs < 0 || ageMs >= POWER_SAMPLE_STALE_THRESHOLD_MS) return dischargeW;
    return dischargeW + Math.max(0, -batteryPower.signedW);
  }, 0)
);
