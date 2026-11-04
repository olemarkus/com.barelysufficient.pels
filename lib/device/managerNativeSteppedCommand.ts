import type {
  DevicePowerControlMode, SteppedLoadProfile, TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { isNativeSteppedLoadWiringCandidate } from './nativeSteppedLoadWiring';
import { getDeviceId } from './transport/managerHelpers';
import {
  CapabilityNativeSteppedLoadCommandAdapter,
  getCapabilityObj,
  type NativeSteppedLoadCommandAdapter,
  type NativeSteppedLoadStepResult,
} from './nativeSteppedLoadCommandChannel';

/**
 * The native stepped-load command adapters of the tracked devices, by device
 * id. The transport snapshot store holds it beside the raw devices the
 * adapters are built from.
 */
export class NativeSteppedLoadCommandAdapters {
  private readonly adapters = new Map<string, NativeSteppedLoadCommandAdapter>();
  private readonly powerControlModes = new Map<string, DevicePowerControlMode>();

  constructor(private readonly getInventory: () => readonly HomeyDeviceLike[]) {}

  /** Keep a device's adapter in step with a fresh read of it. */
  observe(deviceId: string, device: HomeyDeviceLike): void {
    if (!Array.isArray(device.capabilities) || !isNativeSteppedLoadWiringCandidate({
      device,
      capabilities: device.capabilities,
      capabilityObj: getCapabilityObj(device),
    })) {
      this.adapters.delete(deviceId);
      this.powerControlModes.delete(deviceId);
      return;
    }
    const existing = this.adapters.get(deviceId);
    if (existing) existing.syncDevice(device);
    else {
      const initialMode = this.powerControlModes.get(deviceId);
      this.adapters.set(deviceId, new CapabilityNativeSteppedLoadCommandAdapter(
        device, initialMode, this.getInventory,
      ));
    }
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
    for (const deviceId of this.powerControlModes.keys()) {
      if (!observedDeviceIds.has(deviceId)) this.powerControlModes.delete(deviceId);
    }
  }

  /** Write a step through the device's native capability; `false` when it has none for that step. */
  async setStep(
    deviceId: string,
    profile: SteppedLoadProfile,
    desiredStepId: string,
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<NativeSteppedLoadStepResult> {
    const adapter = this.adapters.get(deviceId);
    if (!adapter) return false;
    return adapter.setStep(profile, desiredStepId, setCapability);
  }

  observeCapabilityUpdate(deviceId: string, capabilityId: string, value: unknown): void {
    this.adapters.get(deviceId)?.observeCapabilityUpdate(capabilityId, value);
  }

  /** Keep superseded targets out of fresh parses as well as mode-event reads. */
  projectObservation(snapshot: TransportDeviceSnapshot, device: HomeyDeviceLike): TransportDeviceSnapshot {
    const mode = snapshot.automaticPowerControl?.mode;
    if (mode !== undefined) {
      this.powerControlModes.set(snapshot.id, mode);
    } else this.powerControlModes.delete(snapshot.id);
    // The first parse precedes post-commit tracking adoption. Construct only
    // the published Automatic channel so its first observation is gated too.
    if (mode === 'automatic' && !this.adapters.has(snapshot.id)) this.observe(snapshot.id, device);
    const adapter = this.adapters.get(snapshot.id);
    adapter?.observePowerControlMode(mode);
    return adapter?.projectObservation(snapshot) ?? snapshot;
  }

  getReportedStepId(
    deviceId: string, profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ): string | undefined {
    return this.adapters.get(deviceId)?.getReportedStepId(profile, config);
  }
}
