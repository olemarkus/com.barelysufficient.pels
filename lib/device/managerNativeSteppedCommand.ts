import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap } from './managerControl';
import {
  isNativeSteppedLoadWiringCandidate,
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
} from './nativeSteppedLoadWiring';
import { getDeviceId } from './transport/managerHelpers';

/** One device's native step channel: its step capability, as last read. */
type NativeSteppedLoadCommandAdapter = {
  syncDevice: (device: HomeyDeviceLike) => void;
  setStep: (
    profile: SteppedLoadProfile,
    desiredStepId: string,
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ) => Promise<boolean>;
  observeCapabilityUpdate: (capabilityId: string, value: unknown) => void;
  getReportedStepId: (profile: SteppedLoadProfile) => string | undefined;
};

/**
 * The native stepped-load command adapters of the tracked devices, by device
 * id. The transport snapshot store holds it beside the raw devices the
 * adapters are built from.
 */
export class NativeSteppedLoadCommandAdapters {
  private readonly adapters = new Map<string, NativeSteppedLoadCommandAdapter>();

  /** Keep a device's adapter in step with a fresh read of it. */
  observe(deviceId: string, device: HomeyDeviceLike): void {
    if (!Array.isArray(device.capabilities) || !isNativeSteppedLoadWiringCandidate({
      device,
      capabilities: device.capabilities,
      capabilityObj: getCapabilityObj(device),
    })) {
      this.adapters.delete(deviceId);
      return;
    }
    const existing = this.adapters.get(deviceId);
    if (existing) existing.syncDevice(device);
    else this.adapters.set(deviceId, buildCapabilityNativeSteppedLoadCommandAdapter(device));
  }

  /** Re-observe every tracked device and drop the adapters of the rest. */
  sync(devices: HomeyDeviceLike[], shouldTrackDevice: (deviceId: string) => boolean): void {
    const observedDeviceIds = new Set<string>();
    for (const device of devices) {
      const deviceId = getDeviceId(device);
      if (!deviceId || !shouldTrackDevice(deviceId)) continue;
      observedDeviceIds.add(deviceId);
      this.observe(deviceId, device);
    }
    for (const deviceId of this.adapters.keys()) {
      if (!observedDeviceIds.has(deviceId)) this.adapters.delete(deviceId);
    }
  }

  /** Write a step through the device's native capability; `false` when it has none for that step. */
  async setStep(
    deviceId: string,
    profile: SteppedLoadProfile,
    desiredStepId: string,
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<boolean> {
    const adapter = this.adapters.get(deviceId);
    if (!adapter) return false;
    return adapter.setStep(profile, desiredStepId, setCapability);
  }

  observeCapabilityUpdate(deviceId: string, capabilityId: string, value: unknown): void {
    this.adapters.get(deviceId)?.observeCapabilityUpdate(capabilityId, value);
  }

  getReportedStepId(deviceId: string, profile: SteppedLoadProfile): string | undefined {
    return this.adapters.get(deviceId)?.getReportedStepId(profile);
  }
}

function buildCapabilityNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
): NativeSteppedLoadCommandAdapter {
  let capabilities = Array.isArray(device.capabilities) ? [...device.capabilities] : [];
  let capabilityObj = getCapabilityObj(device);
  return {
    syncDevice(nextDevice) {
      capabilities = Array.isArray(nextDevice.capabilities) ? [...nextDevice.capabilities] : [];
      capabilityObj = getCapabilityObj(nextDevice);
    },
    async setStep(profile, desiredStepId, setCapability) {
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
    /* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
    observeCapabilityUpdate(capabilityId, value) {
      if (!capabilities.includes(capabilityId)) return;
      capabilityObj[capabilityId] = {
        ...capabilityObj[capabilityId],
        value,
      };
    },
    /* eslint-enable functional/immutable-data */
    getReportedStepId(profile) {
      return resolveNativeSteppedLoadReportedStepId({
        profile,
        capabilities,
        capabilityObj,
      });
    },
  };
}

function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as DeviceCapabilityMap
    : {};
}
