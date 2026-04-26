import type { HomeyDeviceLike, SteppedLoadProfile } from '../utils/types';
import type { DeviceCapabilityMap } from './deviceManagerControl';
import {
  isNativeSteppedLoadWiringCandidate,
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
} from './nativeSteppedLoadWiring';
import { getDeviceId } from './deviceManagerHelpers';

export type NativeSteppedLoadCommandAdapter = {
  setStep: (params: {
    profile: SteppedLoadProfile;
    desiredStepId: string;
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>;
  }) => Promise<boolean>;
  observeCapabilityUpdate: (params: {
    capabilityId: string;
    value: unknown;
  }) => boolean;
  getReportedStepId: (profile: SteppedLoadProfile) => string | undefined;
};

const adapterStore = new WeakMap<object, Map<string, NativeSteppedLoadCommandAdapter>>();

export function buildNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
): NativeSteppedLoadCommandAdapter | null {
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
  if (!isNativeSteppedLoadWiringCandidate({ device, capabilities })) return null;
  const capabilityObj = getCapabilityObj(device);
  return {
    async setStep({ profile, desiredStepId, setCapability }) {
      const command = resolveNativeSteppedLoadCommand({
        profile,
        desiredStepId,
        capabilities,
        capabilityObj,
      });
      if (!command) return false;
      await setCapability(command.capabilityId, command.value);
      return true;
    },
    observeCapabilityUpdate({ capabilityId, value }) {
      if (!capabilities.includes(capabilityId)) return false;
      capabilityObj[capabilityId] = {
        ...capabilityObj[capabilityId],
        value,
      };
      return true;
    },
    getReportedStepId(profile) {
      return resolveNativeSteppedLoadReportedStepId({
        profile,
        capabilities,
        capabilityObj,
      });
    },
  };
}

export function observeNativeSteppedLoadCommandAdapter(params: {
  owner: object;
  deviceId: string;
  device: HomeyDeviceLike;
  clearWhenUnavailable: boolean;
}): void {
  const {
    owner,
    deviceId,
    device,
    clearWhenUnavailable,
  } = params;
  const adapters = getAdapterStore(owner);
  if (!Array.isArray(device.capabilities)) {
    if (clearWhenUnavailable) adapters.delete(deviceId);
    return;
  }
  const adapter = buildNativeSteppedLoadCommandAdapter(device);
  if (adapter) adapters.set(deviceId, adapter);
  else adapters.delete(deviceId);
}

export function syncNativeSteppedLoadCommandAdapters(params: {
  owner: object;
  devices: HomeyDeviceLike[];
  shouldTrackDevice: (deviceId: string) => boolean;
}): void {
  const { owner, devices, shouldTrackDevice } = params;
  const adapters = getAdapterStore(owner);
  const observedDeviceIds = new Set<string>();
  for (const device of devices) {
    const deviceId = getDeviceId(device);
    if (!deviceId || !shouldTrackDevice(deviceId)) continue;
    observedDeviceIds.add(deviceId);
    observeNativeSteppedLoadCommandAdapter({
      owner,
      deviceId,
      device,
      clearWhenUnavailable: true,
    });
  }
  for (const deviceId of adapters.keys()) {
    if (!observedDeviceIds.has(deviceId)) adapters.delete(deviceId);
  }
}

export async function setObservedNativeSteppedLoadStep(params: {
  owner: object;
  deviceId: string;
  profile: SteppedLoadProfile;
  desiredStepId: string;
  setCapability: (capabilityId: string, value: unknown) => Promise<unknown>;
}): Promise<boolean> {
  const {
    owner,
    deviceId,
    profile,
    desiredStepId,
    setCapability,
  } = params;
  const adapter = getAdapterStore(owner).get(deviceId);
  if (!adapter) return false;
  return adapter.setStep({ profile, desiredStepId, setCapability });
}

export function observeNativeSteppedLoadCapabilityUpdate(params: {
  owner: object;
  deviceId: string;
  capabilityId: string;
  value: unknown;
}): boolean {
  const {
    owner,
    deviceId,
    capabilityId,
    value,
  } = params;
  const adapter = getAdapterStore(owner).get(deviceId);
  return adapter?.observeCapabilityUpdate({ capabilityId, value }) === true;
}

export function resolveObservedNativeSteppedLoadReportedStepId(params: {
  owner: object;
  deviceId: string;
  profile: SteppedLoadProfile;
}): string | undefined {
  const {
    owner,
    deviceId,
    profile,
  } = params;
  const adapter = getAdapterStore(owner).get(deviceId);
  return adapter?.getReportedStepId(profile);
}

function getAdapterStore(owner: object): Map<string, NativeSteppedLoadCommandAdapter> {
  const existingStore = adapterStore.get(owner);
  if (existingStore) return existingStore;
  const nextStore = new Map<string, NativeSteppedLoadCommandAdapter>();
  adapterStore.set(owner, nextStore);
  return nextStore;
}

function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as DeviceCapabilityMap
    : {};
}
