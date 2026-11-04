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

/** One device's native step channel: its step capability, as last read. */
export type NativeSteppedLoadStepResult = boolean | 'binary_off_required' | 'preparation_issued';

export type NativeSteppedLoadCommandAdapter = {
  syncDevice: (device: HomeyDeviceLike) => void;
  setStep: (
    profile: SteppedLoadProfile,
    desiredStepId: string,
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ) => Promise<NativeSteppedLoadStepResult>;
  observeCapabilityUpdate: (capabilityId: string, value: unknown) => void;
  observePowerControlMode: (mode: DevicePowerControlMode | undefined) => void;
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
  private targetPowerInvalidatedAtMs: number | undefined;
  private targetPowerReportRevision = 0;
  private powerControlMode: DevicePowerControlMode | undefined;
  private powerControlModeGeneration = 0;
  private targetPowerReassertAfterMs: number | undefined;

  constructor(
    device: HomeyDeviceLike,
    initialPowerControlMode: DevicePowerControlMode | undefined,
    private readonly getInventory: () => readonly HomeyDeviceLike[],
  ) {
    this.raw = device;
    this.capabilities = Array.isArray(device.capabilities) ? [...device.capabilities] : [];
    this.capabilityObj = getCapabilityObj(device);
    this.automaticProfile = resolveDeviceAutomaticProfile(device);
    this.powerControlMode = initialPowerControlMode;
    if (initialPowerControlMode === 'automatic') this.observeInitialAutomaticPower();
  }

  syncDevice(nextDevice: HomeyDeviceLike): void {
    const hadNativeWatts = isTargetPowerSteppedLoadCandidate({
      capabilities: this.capabilities, capabilityObj: this.capabilityObj,
    });
    this.raw = nextDevice;
    this.capabilities = Array.isArray(nextDevice.capabilities) ? [...nextDevice.capabilities] : [];
    this.observeAutomaticProfile(resolveDeviceAutomaticProfile(nextDevice));
    if (!isTargetPowerSteppedLoadCandidate({
      capabilities: this.capabilities, capabilityObj: getCapabilityObj(nextDevice),
    })) {
      if (hadNativeWatts) this.powerControlModeGeneration += 1;
      this.targetPowerReassertAfterMs = undefined;
      this.targetPowerInvalidatedAtMs = undefined;
    }
    this.capabilityObj = retainTargetPowerEvidence(
      getCapabilityObj(nextDevice), this.capabilityObj, this.targetPowerInvalidatedAtMs,
    );
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

  private async writeTargetPower(
    write: CapabilityWrite, setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<NativeSteppedLoadStepResult> {
    const generation = this.powerControlModeGeneration;
    const reasserting = this.targetPowerReassertAfterMs !== undefined;
    const preparation = reasserting ? await this.prepareReassertion(generation, setCapability) : 'unchanged';
    // A preparation write went out, even one a newer mode choice superseded.
    // The step itself waits for the next decision.
    if (preparation === 'issued') return 'preparation_issued';
    if (!this.ownsTargetPowerWrite(generation)) return false;
    if (preparation === 'binary_off_required') return preparation;
    const takingControl = preparation === 'reset' || needsTargetPowerTakeover(this.capabilities, this.capabilityObj);
    const requestedAtMs = Date.now();
    const reportRevision = this.targetPowerReportRevision;
    await setCapability(write.capabilityId, write.value);
    // An older issued write cannot take over or release a newer reclaim latch.
    if (!this.ownsTargetPowerWrite(generation)) return true;
    if (takingControl) {
      this.invalidateSupersededTarget(write, reportRevision, requestedAtMs);
      // Store the admitted ceiling first: claiming can immediately apply it.
      await setCapability('target_power_mode', 'homey');
    }
    if (reasserting && this.ownsTargetPowerWrite(generation)) {
      this.targetPowerReassertAfterMs = undefined;
      // Only independent readback of this request can reclaim retained polls.
      if (reportRevision === this.targetPowerReportRevision) this.invalidateTargetPower(requestedAtMs);
    }
    return true;
  }

  private async prepareReassertion(
    generation: number, setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
  ): Promise<'unchanged' | 'reset' | 'issued' | 'binary_off_required'> {
    if (this.targetPowerReassertAfterMs === undefined) return 'unchanged';
    const preparation = getDeviceAdapter(this.raw).prepareTargetPowerReassertion(this.raw, this.getInventory());
    if (preparation.kind === 'stop') {
      // Binary preparation belongs to the executor's ordinary binary dispatch:
      // it records pending provenance before the write and waits for telemetry.
      if (preparation.write.value === false) return 'binary_off_required';
      await setCapability(preparation.write.capabilityId, preparation.write.value);
      return 'issued';
    }
    for (const reset of preparation.resetWrites) {
      await setCapability(reset.capabilityId, reset.value);
      if (!this.ownsTargetPowerWrite(generation)) return 'issued';
    }
    return preparation.resetWrites.length > 0 ? 'reset' : 'unchanged';
  }

  observeCapabilityUpdate(capabilityId: string, value: unknown): void {
    if (!this.capabilities.includes(capabilityId)) return;
    if (capabilityId === 'target_power') this.targetPowerReportRevision += 1;
    this.capabilityObj = withNativeCapabilityObservation(this.capabilityObj, capabilityId, value);
  }

  observePowerControlMode(mode: DevicePowerControlMode | undefined): void {
    if (this.powerControlMode !== mode) this.powerControlModeGeneration += 1;
    if (this.powerControlMode === undefined && mode === 'automatic') this.observeInitialAutomaticPower();
    if (mode === undefined && this.powerControlMode !== undefined) {
      this.targetPowerReassertAfterMs = undefined;
      this.targetPowerInvalidatedAtMs = undefined;
    }
    if (this.powerControlMode === 'manual' && mode === 'automatic'
      && isTargetPowerSteppedLoadCandidate({ capabilities: this.capabilities, capabilityObj: this.capabilityObj })) {
      this.requireTargetPowerReassertion();
    }
    this.powerControlMode = mode;
  }

  projectObservation(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    if (this.usesManualCurrentRoute()) return snapshot;
    if (snapshot.automaticPowerControl?.mode === 'automatic') {
      this.observeAutomaticProfile(snapshot.automaticPowerControl.profile);
    }
    if (this.targetPowerReassertAfterMs === undefined && (this.targetPowerInvalidatedAtMs === undefined
      || (snapshot.reportedStepObservedAtMs !== undefined
        && snapshot.reportedStepObservedAtMs > this.targetPowerInvalidatedAtMs))) return snapshot;
    const {
      reportedStepId: _supersededStep, reportedStepPowerW: _supersededPower,
      reportedStepObservedAtMs: _supersededAt, ...retained
    } = snapshot;
    // A dated invalidation keeps refresh merge from restoring the superseded rung.
    return { ...retained, reportedStepObservedAtMs: this.targetPowerInvalidatedAtMs };
  }

  getReportedStepId(
    profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ): string | undefined {
    if (this.targetPowerReassertAfterMs !== undefined) return undefined;
    return resolveAdapterReportedStep(this.raw, this.capabilityObj, profile, config);
  }

  private usesManualCurrentRoute(): boolean {
    return this.powerControlMode === 'manual' && getDeviceAdapter(this.raw).currentBindings(this.raw).length > 0;
  }

  private ownsTargetPowerWrite(generation: number): boolean {
    return !this.usesManualCurrentRoute() && generation === this.powerControlModeGeneration;
  }

  private observeAutomaticProfile(next: SteppedLoadProfile | undefined): void {
    if (this.powerControlMode === 'automatic' && isTargetPowerSteppedLoadCandidate({
      capabilities: this.capabilities, capabilityObj: getCapabilityObj(this.raw),
    }) && !sameAutomaticProfile(this.automaticProfile, next)) {
      this.powerControlModeGeneration += 1;
      this.requireTargetPowerReassertion();
    }
    this.automaticProfile = next;
  }

  private requireTargetPowerReassertion(): void {
    this.targetPowerReassertAfterMs = Date.now();
    this.targetPowerInvalidatedAtMs = Math.max(
      this.targetPowerInvalidatedAtMs ?? 0, this.targetPowerReassertAfterMs,
    );
  }

  private observeInitialAutomaticPower(): void {
    if (!isTargetPowerSteppedLoadCandidate({
      capabilities: this.capabilities, capabilityObj: this.capabilityObj,
    })) return;
    const preparation = getDeviceAdapter(this.raw).prepareTargetPowerReassertion(this.raw, this.getInventory());
    if (preparation.kind === 'stop' || preparation.resetWrites.length > 0) this.requireTargetPowerReassertion();
  }

  private invalidateTargetPower(atMs: number): void {
    this.targetPowerInvalidatedAtMs = Math.max(this.targetPowerInvalidatedAtMs ?? 0, atMs);
    this.capabilityObj = retainTargetPowerEvidence(
      this.capabilityObj, this.capabilityObj, this.targetPowerInvalidatedAtMs,
    );
  }

  private invalidateSupersededTarget(
    write: CapabilityWrite, reportRevision: number, requestedAtMs: number,
  ): void {
    const target = this.capabilityObj.target_power;
    // A driver can publish its bounded target during dispatch, in the same ms.
    if (reportRevision === this.targetPowerReportRevision && !Object.is(target?.value, write.value)
      && (toCapabilityTimestampMs(target?.lastUpdated) ?? 0) <= requestedAtMs) {
      this.invalidateTargetPower(requestedAtMs);
    }
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
    profile, capabilities: device.capabilities ?? [], capabilityObj: values,
  });
}

function supportsAutomaticStep(profile: SteppedLoadProfile | undefined, step: SteppedLoadStep): boolean {
  return profile?.steps.some((current) => current.planningPowerW === step.planningPowerW
    && current.planningCurrentA === step.planningCurrentA) === true;
}

function sameAutomaticProfile(previous: SteppedLoadProfile | undefined, next: SteppedLoadProfile | undefined): boolean {
  if (!previous || !next) return previous === next;
  return previous.steps.length === next.steps.length && previous.steps.every((step, index) => {
    const other = next.steps[index];
    return other !== undefined && step.id === other.id && step.planningPowerW === other.planningPowerW
      && step.planningCurrentA === other.planningCurrentA;
  });
}

function resolveDeviceAutomaticProfile(device: HomeyDeviceLike): SteppedLoadProfile | undefined {
  const overlay = getDeviceAdapter(device).overlay(device, device.capabilities ?? [], getCapabilityObj(device));
  return resolveAutomaticSteppedLoadProfile(device, overlay.capabilities, overlay.capabilityObj);
}

function retainTargetPowerEvidence(
  next: DeviceCapabilityMap, previous: DeviceCapabilityMap, invalidatedAtMs: number | undefined,
): DeviceCapabilityMap {
  if (invalidatedAtMs === undefined) return next;
  const current = previous.target_power;
  const currentAt = toCapabilityTimestampMs(current?.lastUpdated);
  const nextAt = toCapabilityTimestampMs(next.target_power?.lastUpdated);
  if (nextAt !== undefined && nextAt > invalidatedAtMs
      && (currentAt === undefined || nextAt >= currentAt)) return next;
  if (current && currentAt !== undefined && currentAt > invalidatedAtMs) {
    return { ...next, target_power: { ...next.target_power,
      value: current.value, lastUpdated: current.lastUpdated } };
  }
  // Retain the capability's writable range, but no superseded value. A mode
  // report alone must not turn that former target back into step evidence.
  const { value: _superseded, ...target } = next.target_power ?? {};
  return { ...next, target_power: target };
}

export function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as DeviceCapabilityMap
    : {};
}

function needsTargetPowerTakeover(capabilities: string[], capabilityObj: DeviceCapabilityMap): boolean {
  return capabilities.includes('target_power_mode')
    && capabilityObj.target_power_mode?.setable === true
    && capabilityObj.target_power_mode.value !== 'homey';
}
