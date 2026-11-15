import type {
  DevicePowerControlMode, SteppedLoadProfile, SteppedLoadStep, TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../utils/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';
import {
  isTargetPowerSteppedLoadCandidate,
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
  resolveAutomaticSteppedLoadProfile,
  type CapabilityWrite,
} from './nativeSteppedLoadWiring';

/** One device's native step channel: whether the step went out. */
export type NativeSteppedLoadStepResult = boolean;

export type NativeSteppedLoadCommandAdapter = {
  syncDevice: (device: HomeyDeviceLike) => void;
  setStep: (
    profile: SteppedLoadProfile,
    desiredStepId: string,
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ) => Promise<NativeSteppedLoadStepResult>;
  observeCapabilityUpdate: (capabilityId: string, value: unknown) => void;
  observePowerControlMode: (mode: DevicePowerControlMode | undefined) => void;
  controlsTargetPower: () => boolean;
  claimTargetPower: (
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ) => Promise<boolean>;
  projectObservation: (snapshot: TransportDeviceSnapshot) => TransportDeviceSnapshot;
  getReportedStepId: (
    profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ) => string | undefined;
};

export class CapabilityNativeSteppedLoadCommandAdapter implements NativeSteppedLoadCommandAdapter {
  private raw: HomeyDeviceLike;
  private capabilities: string[];
  private capabilityObj: DeviceCapabilityMap;
  private automaticProfile: SteppedLoadProfile | undefined;
  private powerControlMode: DevicePowerControlMode | undefined;
  /**
   * When the Automatic watt ladder last changed. A target the device held then
   * was set under the old ladder, where the same watts could come to another
   * current, so it is no reading of the step until the device reports a target
   * again. Stepping from it could move the device by far more than one step.
   */
  private ladderChangedAtMs: number | undefined;

  constructor(device: HomeyDeviceLike, initialPowerControlMode: DevicePowerControlMode | undefined) {
    this.raw = device;
    this.capabilities = Array.isArray(device.capabilities) ? [...device.capabilities] : [];
    this.capabilityObj = getCapabilityObj(device);
    this.automaticProfile = resolveDeviceAutomaticProfile(device);
    this.powerControlMode = initialPowerControlMode;
  }

  syncDevice(nextDevice: HomeyDeviceLike): void {
    this.raw = nextDevice;
    this.capabilities = Array.isArray(nextDevice.capabilities) ? [...nextDevice.capabilities] : [];
    this.capabilityObj = getCapabilityObj(nextDevice);
    this.observeAutomaticProfile(resolveDeviceAutomaticProfile(nextDevice));
  }

  async setStep(
    profile: SteppedLoadProfile, desiredStepId: string,
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<NativeSteppedLoadStepResult> {
    const command = resolveNativeSteppedLoadCommand({
      profile, desiredStepId, capabilities: this.capabilities, capabilityObj: this.capabilityObj,
    });
    const step = getSteppedLoadStep(profile, desiredStepId);
    if (!command || !step) return false;
    if (this.usesManualCurrentRoute() && command.capabilityId === 'target_power') return false;
    const write = getDeviceAdapter(this.raw).stepCommand(this.raw, step, command);
    if (this.powerControlMode === 'automatic' && !supportsAutomaticStep(this.automaticProfile, step)) return false;
    if (write.capabilityId === 'target_power') return this.writeTargetPower(write, setCapability);
    await setCapability(write.capabilityId, write.value);
    return true;
  }

  /** The watt target alone. Homey's control of it is claimed on its own (`claimTargetPower`). */
  private async writeTargetPower(
    write: CapabilityWrite, setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<NativeSteppedLoadStepResult> {
    await setCapability(write.capabilityId, write.value);
    return true;
  }

  /** Whether PELS steps this device through its watt target, so that Homey must hold it. */
  controlsTargetPower(): boolean {
    return !this.usesManualCurrentRoute() && isTargetPowerSteppedLoadCandidate({
      capabilities: this.capabilities, capabilityObj: getCapabilityObj(this.raw),
    });
  }

  /**
   * Take Homey's control of the watt target: `target_power_mode = homey`, and
   * nothing else. The watt target is a separate decision, written as a step
   * where PELS limits the device's power. The mode is then left at `homey`:
   * PELS never hands it back to reset the device. Returns false, sending
   * nothing, for a device PELS does not step through its watt target.
   */
  async claimTargetPower(
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<boolean> {
    if (!this.controlsTargetPower() || !this.capabilities.includes('target_power_mode')) return false;
    await setCapability('target_power_mode', 'homey');
    return true;
  }

  observeCapabilityUpdate(capabilityId: string, value: unknown): void {
    if (!this.capabilities.includes(capabilityId)) return;
    this.capabilityObj = withNativeCapabilityObservation(this.capabilityObj, capabilityId, value);
  }

  observePowerControlMode(mode: DevicePowerControlMode | undefined): void {
    this.powerControlMode = mode;
  }

  /** The ladder Automatic publishes now: the next step is written in it. */
  projectObservation(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    if (this.usesManualCurrentRoute()) return snapshot;
    if (snapshot.automaticPowerControl?.mode === 'automatic') {
      this.observeAutomaticProfile(snapshot.automaticPowerControl.profile);
    }
    const changedAtMs = this.ladderChangedAtMs;
    if (changedAtMs === undefined) return snapshot;
    if (snapshot.reportedStepObservedAtMs !== undefined && snapshot.reportedStepObservedAtMs > changedAtMs) {
      this.ladderChangedAtMs = undefined;
      return snapshot;
    }
    const {
      reportedStepId: _staleStep, reportedStepPowerW: _stalePower, reportedStepObservedAtMs: _staleAt, ...retained
    } = snapshot;
    // Dated by the change, so a refresh merge cannot restore the stale step.
    return { ...retained, reportedStepObservedAtMs: changedAtMs };
  }

  private observeAutomaticProfile(next: SteppedLoadProfile | undefined): void {
    if (this.controlsTargetPower() && this.automaticProfile !== undefined
      && !sameAutomaticProfile(this.automaticProfile, next)) this.ladderChangedAtMs = Date.now();
    this.automaticProfile = next;
  }

  getReportedStepId(
    profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ): string | undefined {
    // A mode report alone cannot turn a target from the old ladder back into a step.
    if (this.ladderChangedAtMs !== undefined
      && (toCapabilityTimestampMs(this.capabilityObj.target_power?.lastUpdated) ?? 0) <= this.ladderChangedAtMs) {
      return undefined;
    }
    return resolveAdapterReportedStep(this.raw, this.capabilityObj, profile, config);
  }

  private usesManualCurrentRoute(): boolean {
    return this.powerControlMode === 'manual' && getDeviceAdapter(this.raw).currentBindings(this.raw).length > 0;
  }
}

function withNativeCapabilityObservation(
  values: DeviceCapabilityMap, capabilityId: string, value: unknown,
): DeviceCapabilityMap {
  return { ...values, [capabilityId]: { ...values[capabilityId], value,
    ...(capabilityId === 'target_power' ? { lastUpdated: new Date().toISOString() } : {}),
  } };
}

function resolveAdapterReportedStep(
  device: HomeyDeviceLike, capabilityObj: DeviceCapabilityMap,
  profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
): string | undefined {
  const target = capabilityObj.target_power;
  const values = config && typeof target?.value === 'number'
    ? { ...capabilityObj, target_power: { ...target,
      value: getDeviceAdapter(device).targetPowerReading(device, config, target.value) } }
    : capabilityObj;
  return resolveNativeSteppedLoadReportedStepId({
    profile, capabilities: device.capabilities, capabilityObj: values,
  });
}

function supportsAutomaticStep(profile: SteppedLoadProfile | undefined, step: SteppedLoadStep): boolean {
  return profile?.steps.some((current) => current.planningPowerW === step.planningPowerW
    && current.planningCurrentA === step.planningCurrentA) === true;
}

function sameAutomaticProfile(previous: SteppedLoadProfile, next: SteppedLoadProfile | undefined): boolean {
  return next !== undefined && previous.steps.length === next.steps.length
    && previous.steps.every((step, index) => {
      const other = next.steps[index];
      return other !== undefined && step.id === other.id && step.planningPowerW === other.planningPowerW
        && step.planningCurrentA === other.planningCurrentA;
    });
}

function resolveDeviceAutomaticProfile(device: HomeyDeviceLike): SteppedLoadProfile | undefined {
  const overlay = getDeviceAdapter(device).overlay(device, device.capabilities, getCapabilityObj(device));
  return resolveAutomaticSteppedLoadProfile(device, overlay.capabilities, overlay.capabilityObj);
}

export function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
  return device.capabilitiesObj as DeviceCapabilityMap;
}
