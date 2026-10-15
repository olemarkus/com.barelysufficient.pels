import { getDeviceAdapter, getSnapshotAdapter } from './deviceAdapterRegistry';
import type { DeviceAdapter, AdapterSnapshot, AdapterObservation } from './deviceAdapter';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap } from './managerControl';
import type { DeviceControlAdapterSnapshot } from '../../packages/contracts/src/types';

export const hasOfficialEvChargerCapabilities = (capabilities: readonly string[]): boolean => (
  capabilities.includes('evcharger_charging') && capabilities.includes('evcharger_charging_state')
);

export function applyNativeEvWiringOverlay(
  device: HomeyDeviceLike, capabilities: string[], capabilityObj: DeviceCapabilityMap,
): { capabilities: string[]; capabilityObj: DeviceCapabilityMap; controlAdapter?: DeviceControlAdapterSnapshot;
  binaryWriteCapabilityId?: string; binaryObservationCapabilityId?: string } {
  const overlay = getDeviceAdapter(device).overlay(device, capabilities, capabilityObj);
  if (overlay.kind === 'standard') return { capabilities: overlay.capabilities, capabilityObj: overlay.capabilityObj };
  return {
    capabilities: overlay.capabilities, capabilityObj: overlay.capabilityObj, controlAdapter: overlay.controlAdapter,
    ...(overlay.binaryTarget.kind === 'capability' ? {
      binaryWriteCapabilityId: overlay.binaryTarget.writeCapabilityId,
      binaryObservationCapabilityId: overlay.binaryTarget.observationCapabilityId,
    } : {}),
  };
}

export function normalizeNativeEvCapabilityUpdate(
  snapshot: AdapterSnapshot, capabilityId: string, value: unknown,
): ReturnType<DeviceAdapter['normalize']> {
  if (snapshot.controlAdapter?.activationEnabled !== true) return [{ capabilityId, value }];
  return getSnapshotAdapter(snapshot).normalize(snapshot, capabilityId, value);
}

export function buildNativeEvObservationCapabilityObj(
  device: HomeyDeviceLike, previousSnapshot: AdapterObservation | null | undefined,
): DeviceCapabilityMap {
  const values = getDeviceAdapter(device).observation(device);
  return previousSnapshot?.controlAdapter?.activationEnabled === true
    ? getDeviceAdapter(device).finalizeObservation(
      previousSnapshot.controlAdapter, previousSnapshot.capabilities ?? [], values,
    )
    : values;
}

export function buildNativeEvObservationDevice(
  device: HomeyDeviceLike, previousSnapshot: AdapterObservation | null | undefined,
): HomeyDeviceLike {
  return { ...device, capabilitiesObj: buildNativeEvObservationCapabilityObj(device, previousSnapshot) };
}
