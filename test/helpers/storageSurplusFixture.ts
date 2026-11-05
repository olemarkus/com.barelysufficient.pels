import type { StorageDischargeObservation } from '../../packages/planner-types/src/storageDischarge';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { StorageLeverState } from '../../lib/plan/planState';
import { hasStorageInput } from '../../lib/plan/battery/storageLadder';
import { resolveStorageSurplusClaimants, resolveStorageDischargeW } from '../../lib/plan/battery/storageRelief';

/** Planner fixtures provide storage readings through the independent whole-home port. */
export const storageDischargeObservationsFixture = (devices: readonly PlanInputDevice[]): ReadonlyMap<string, StorageDischargeObservation> => new Map(
  devices.flatMap((device) => hasStorageInput(device) && device.storage.reading !== 'missing'
    ? [[device.id, { dischargeW: Math.max(0, -device.storage.signedPowerW), heldDischarge: 'releasable' as const }] as const] : []),
);

export const storageSurplusFixture = (
  devices: readonly PlanInputDevice[], levers: Readonly<Record<string, StorageLeverState>>, signedNetW: number,
) => ({
  claimants: resolveStorageSurplusClaimants(devices, levers, signedNetW),
  dischargeW: resolveStorageDischargeW(storageDischargeObservationsFixture(devices), levers),
});
