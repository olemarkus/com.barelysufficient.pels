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
