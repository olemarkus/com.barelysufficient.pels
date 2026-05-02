import type {
  HomeyDeviceLike,
  Logger,
  NativeSteppedLoadStatusSnapshot,
  SteppedLoadProfile,
} from '../utils/types';
import type { DeviceCapabilityMap } from './deviceManagerControl';
import { runRawFlowCardAction } from './deviceManagerHomeyApi';
import {
  isNativeSteppedLoadWiringCandidate,
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
} from './nativeSteppedLoadWiring';
import {
  buildZaptecSharedInstallationBlockSet,
  isZaptecNativeSteppedLoadWiringCandidate,
  resolveZaptecInstallationId,
} from './zaptecNativeSteppedLoad';
import { getDeviceId } from './deviceManagerHelpers';
import { buildZaptecNativeSteppedLoadCommandAdapter } from './zaptecNativeSteppedCommandAdapter';

export type NativeSteppedLoadCommandAdapter = {
  kind: 'capability' | 'zaptec';
  syncDevice: (params: {
    device: HomeyDeviceLike;
    sharedInstallationBlocked: boolean;
    logger?: Logger;
  }) => void;
  setStep: (params: {
    profile: SteppedLoadProfile;
    desiredStepId: string;
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>;
    runFlowCardAction: (params: {
      uri: string;
      id: string;
      args?: Record<string, unknown>;
    }) => Promise<unknown>;
    logger?: Logger;
  }) => Promise<boolean>;
  observeCapabilityUpdate: (params: {
    capabilityId: string;
    value: unknown;
    logger?: Logger;
  }) => boolean;
  getReportedStepId: (profile?: SteppedLoadProfile) => string | undefined;
  getStatus: () => NativeSteppedLoadStatusSnapshot | undefined;
};

const adapterStore = new WeakMap<object, Map<string, NativeSteppedLoadCommandAdapter>>();

export function buildNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
  logger?: Logger,
  sharedInstallationBlocked = false,
): NativeSteppedLoadCommandAdapter | null {
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
  if (isZaptecNativeSteppedLoadWiringCandidate({ device, capabilities })) {
    return buildZaptecNativeSteppedLoadCommandAdapter(
      device,
      sharedInstallationBlocked,
      getCapabilityObj,
      logger,
    );
  }
  if (isNativeSteppedLoadWiringCandidate({ device, capabilities })) {
    return buildCapabilityNativeSteppedLoadCommandAdapter(device);
  }
  return null;
}

function resolveNativeSteppedLoadCommandAdapterKind(
  device: HomeyDeviceLike,
): NativeSteppedLoadCommandAdapter['kind'] | null {
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
  if (isZaptecNativeSteppedLoadWiringCandidate({ device, capabilities })) return 'zaptec';
  if (isNativeSteppedLoadWiringCandidate({ device, capabilities })) return 'capability';
  return null;
}

export function observeNativeSteppedLoadCommandAdapter(params: {
  owner: object;
  deviceId: string;
  device: HomeyDeviceLike;
  clearWhenUnavailable: boolean;
  logger?: Logger;
  sharedInstallationBlocked: boolean;
}): void {
  const {
    owner,
    deviceId,
    device,
    clearWhenUnavailable,
    logger,
    sharedInstallationBlocked,
  } = params;
  const adapters = getAdapterStore(owner);
  if (!Array.isArray(device.capabilities)) {
    if (clearWhenUnavailable) adapters.delete(deviceId);
    return;
  }

  const existing = adapters.get(deviceId);
  const nextKind = resolveNativeSteppedLoadCommandAdapterKind(device);
  if (existing && existing.kind === nextKind) {
    existing.syncDevice({ device, sharedInstallationBlocked, logger });
    return;
  }

  const adapter = buildNativeSteppedLoadCommandAdapter(device, logger, sharedInstallationBlocked);
  if (adapter) adapters.set(deviceId, adapter);
  else adapters.delete(deviceId);
}

export function syncNativeSteppedLoadCommandAdapters(params: {
  owner: object;
  devices: HomeyDeviceLike[];
  shouldTrackDevice: (deviceId: string) => boolean;
  logger?: Logger;
}): void {
  const { owner, devices, shouldTrackDevice, logger } = params;
  const adapters = getAdapterStore(owner);
  const observedDeviceIds = new Set<string>();
  const sharedInstallations = buildZaptecSharedInstallationBlockSet(devices);
  for (const device of devices) {
    const deviceId = getDeviceId(device);
    if (!deviceId || !shouldTrackDevice(deviceId)) continue;
    observedDeviceIds.add(deviceId);
    const installationId = resolveZaptecInstallationId(device);
    observeNativeSteppedLoadCommandAdapter({
      owner,
      deviceId,
      device,
      clearWhenUnavailable: true,
      logger,
      sharedInstallationBlocked: installationId ? sharedInstallations.has(installationId) : false,
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
  runFlowCardAction?: (params: {
    uri: string;
    id: string;
    args?: Record<string, unknown>;
  }) => Promise<unknown>;
  logger?: Logger;
}): Promise<boolean> {
  const {
    owner,
    deviceId,
    profile,
    desiredStepId,
    setCapability,
    runFlowCardAction = runRawFlowCardAction,
    logger,
  } = params;
  const adapter = getAdapterStore(owner).get(deviceId);
  if (!adapter) return false;
  return adapter.setStep({
    profile,
    desiredStepId,
    setCapability,
    runFlowCardAction,
    logger,
  });
}

export function observeNativeSteppedLoadCapabilityUpdate(params: {
  owner: object;
  deviceId: string;
  capabilityId: string;
  value: unknown;
  logger?: Logger;
}): boolean {
  const {
    owner,
    deviceId,
    capabilityId,
    value,
    logger,
  } = params;
  const adapter = getAdapterStore(owner).get(deviceId);
  return adapter?.observeCapabilityUpdate({ capabilityId, value, logger }) === true;
}

export function resolveObservedNativeSteppedLoadReportedStepId(params: {
  owner: object;
  deviceId: string;
  profile?: SteppedLoadProfile;
}): string | undefined {
  const {
    owner,
    deviceId,
    profile,
  } = params;
  const adapter = getAdapterStore(owner).get(deviceId);
  return adapter?.getReportedStepId(profile);
}

export function resolveObservedNativeSteppedLoadStatus(params: {
  owner: object;
  deviceId: string;
}): NativeSteppedLoadStatusSnapshot | undefined {
  const adapter = getAdapterStore(params.owner).get(params.deviceId);
  return adapter?.getStatus();
}

function buildCapabilityNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
): NativeSteppedLoadCommandAdapter {
  let capabilities = Array.isArray(device.capabilities) ? [...device.capabilities] : [];
  let capabilityObj = getCapabilityObj(device);
  return {
    kind: 'capability',
    syncDevice({ device: nextDevice }) {
      capabilities = Array.isArray(nextDevice.capabilities) ? [...nextDevice.capabilities] : [];
      capabilityObj = getCapabilityObj(nextDevice);
    },
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
      if (!profile) return undefined;
      return resolveNativeSteppedLoadReportedStepId({
        profile,
        capabilities,
        capabilityObj,
      });
    },
    getStatus() {
      return undefined;
    },
  };
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
