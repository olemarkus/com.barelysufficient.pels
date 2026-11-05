import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { StorageLeverState } from '../../lib/plan/planState';
import { hasStorageInput } from '../../lib/plan/battery/storageLadder';
import { resolveStorageSurplusClaimants, resolveStorageDischargeW } from '../../lib/plan/battery/storageRelief';

/** Planner fixtures provide storage readings through the independent whole-home port. */
export const observedBatteryPowerFixture = (devices: readonly PlanInputDevice[]): ReadonlyMap<string, number> => new Map(
  devices.flatMap((device) => hasStorageInput(device) && device.storage.reading !== 'missing'
    ? [[device.id, device.storage.signedPowerW] as const] : []),
);

export const storageSurplusFixture = (
  devices: readonly PlanInputDevice[], levers: Readonly<Record<string, StorageLeverState>>, signedNetW: number,
) => ({
  claimants: resolveStorageSurplusClaimants(devices, levers, signedNetW),
  dischargeW: resolveStorageDischargeW(observedBatteryPowerFixture(devices), levers),
});
