import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { StorageDischargeObservation } from '../../packages/planner-types/src/storageDischarge';

/**
 * Discharge in one home, independent of control permission. Unavailability
 * cannot prove that a battery stopped: retain its accepted discharge until
 * replaced or removed from the roster, without releasing any larger held debit.
 */
export function projectStorageDischargeObservations(
  devices: readonly DeviceSurfaces[],
): ReadonlyMap<string, StorageDischargeObservation> {
  return new Map(devices.flatMap((device) => (
    device.batteryPower !== undefined
      ? [[device.id, {
        dischargeW: Math.max(0, -device.batteryPower.signedW),
        heldDischarge: device.available ? 'releasable' as const : 'reserved' as const,
      }] as const] : []
  )));
}

export const readFreshHomeBatteryDischargeW = (devices: readonly DeviceSurfaces[], nowMs: number): number => (
  devices.reduce((dischargeW, { available, batteryPower }) => {
    if (!available || !batteryPower) return dischargeW;
    const ageMs = nowMs - batteryPower.observedAtMs;
    if (ageMs < 0 || ageMs >= POWER_SAMPLE_STALE_THRESHOLD_MS) return dischargeW;
    return dischargeW + Math.max(0, -batteryPower.signedW);
  }, 0)
);
