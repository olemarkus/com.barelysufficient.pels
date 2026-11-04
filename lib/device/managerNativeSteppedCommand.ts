import type {
  DevicePowerControlMode, SteppedLoadProfile, SteppedLoadStep, TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../utils/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';
import {
  isNativeSteppedLoadWiringCandidate,
  isTargetPowerSteppedLoadCandidate,
  resolveNativeSteppedLoadCommand,
  resolveNativeSteppedLoadReportedStepId,
  resolveAutomaticSteppedLoadProfile,
  type CapabilityWrite,
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
  observePowerControlMode: (mode: DevicePowerControlMode | undefined) => void;
  projectObservation: (snapshot: TransportDeviceSnapshot) => TransportDeviceSnapshot;
  getReportedStepId: (
    profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ) => string | undefined;
};

/**
 * The native stepped-load command adapters of the tracked devices, by device
 * id. The transport snapshot store holds it beside the raw devices the
 * adapters are built from.
 */
export class NativeSteppedLoadCommandAdapters {
  private readonly adapters = new Map<string, NativeSteppedLoadCommandAdapter>();
  private readonly powerControlModes = new Map<string, DevicePowerControlMode>();

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
      this.adapters.set(deviceId, buildCapabilityNativeSteppedLoadCommandAdapter(device, initialMode));
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
  ): Promise<boolean> {
    const adapter = this.adapters.get(deviceId);
    if (!adapter) return false;
    return adapter.setStep(profile, desiredStepId, setCapability);
  }

  observeCapabilityUpdate(deviceId: string, capabilityId: string, value: unknown): void {
    this.adapters.get(deviceId)?.observeCapabilityUpdate(capabilityId, value);
  }

  /** Keep superseded targets out of fresh parses as well as mode-event reads. */
  projectObservation(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    const adapter = this.adapters.get(snapshot.id);
    const mode = snapshot.automaticPowerControl?.mode;
    if (mode !== undefined) {
      this.powerControlModes.set(snapshot.id, mode);
    } else this.powerControlModes.delete(snapshot.id);
    adapter?.observePowerControlMode(mode);
    return adapter?.projectObservation(snapshot) ?? snapshot;
  }

  getReportedStepId(
    deviceId: string, profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ): string | undefined {
    return this.adapters.get(deviceId)?.getReportedStepId(profile, config);
  }
}

function buildCapabilityNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
  initialPowerControlMode: DevicePowerControlMode | undefined,
): NativeSteppedLoadCommandAdapter {
  let raw = device;
  let capabilities = Array.isArray(device.capabilities) ? [...device.capabilities] : [];
  let capabilityObj = getCapabilityObj(device);
  let automaticProfile = resolveDeviceAutomaticProfile(device);
  let targetPowerInvalidatedAtMs: number | undefined;
  let targetPowerReportRevision = 0;
  let powerControlMode = initialPowerControlMode;
  let powerControlModeGeneration = 0;
  let requiresTargetPowerReassertion = false;
  const invalidateTargetPower = (atMs: number): void => {
    targetPowerInvalidatedAtMs = Math.max(targetPowerInvalidatedAtMs ?? 0, atMs);
    capabilityObj = retainTargetPowerEvidence(capabilityObj, capabilityObj, targetPowerInvalidatedAtMs);
  };
  const invalidateSupersededTarget = (write: CapabilityWrite, reportRevision: number, requestedAtMs: number): void => {
    const target = capabilityObj.target_power;
    // A driver can publish its actual bounded target during dispatch. That
    // report already replaced the old cap, even in the same millisecond.
    if (reportRevision === targetPowerReportRevision && !Object.is(target?.value, write.value)
        && (toCapabilityTimestampMs(target?.lastUpdated) ?? 0) <= requestedAtMs) invalidateTargetPower(requestedAtMs);
  };
  const usesManualCurrentRoute = (): boolean => powerControlMode === 'manual'
    && getDeviceAdapter(raw).currentBindings(raw).length > 0;
  const ownsTargetPowerWrite = (generation: number): boolean => !usesManualCurrentRoute()
    && generation === powerControlModeGeneration;
  const observeAutomaticProfile = (next: SteppedLoadProfile | undefined): void => {
    if (powerControlMode === 'automatic' && isTargetPowerSteppedLoadCandidate({
      capabilities, capabilityObj: getCapabilityObj(raw),
    }) && !sameAutomaticProfile(automaticProfile, next)) {
      powerControlModeGeneration += 1;
      requiresTargetPowerReassertion = true;
      targetPowerInvalidatedAtMs = Math.max(targetPowerInvalidatedAtMs ?? 0, Date.now());
    }
    automaticProfile = next;
  };
  return {
    syncDevice(nextDevice) {
      const hadNativeWatts = isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj });
      raw = nextDevice;
      capabilities = Array.isArray(nextDevice.capabilities) ? [...nextDevice.capabilities] : [];
      observeAutomaticProfile(resolveDeviceAutomaticProfile(nextDevice));
      if (!isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj: getCapabilityObj(nextDevice) })) {
        if (hadNativeWatts) powerControlModeGeneration += 1;
        requiresTargetPowerReassertion = false;
        targetPowerInvalidatedAtMs = undefined;
      }
      capabilityObj = retainTargetPowerEvidence(
        getCapabilityObj(nextDevice), capabilityObj, targetPowerInvalidatedAtMs,
      );
    },
    async setStep(profile, desiredStepId, setCapability) {
      const command = resolveNativeSteppedLoadCommand({
        profile,
        desiredStepId,
        capabilities,
        capabilityObj,
      });
      const step = getSteppedLoadStep(profile, desiredStepId);
      if (!command || !step) return false;
      if (usesManualCurrentRoute() && command.capabilityId === 'target_power') return false;
      const write = getDeviceAdapter(raw).stepCommand(raw, step, command);
      if (powerControlMode === 'automatic' && !supportsAutomaticStep(automaticProfile, step)) return false;
      const takingControl = needsTargetPowerTakeover(capabilities, capabilityObj);
      const reassertingTargetPower = write.capabilityId === 'target_power' && requiresTargetPowerReassertion;
      const requestedAtMs = Date.now();
      const reportRevision = targetPowerReportRevision;
      const controlGeneration = powerControlModeGeneration;
      await setCapability(write.capabilityId, write.value);
      // An already issued write may finish after the owner changed control.
      // It cannot take over the mode or release a newer reassertion latch.
      if (write.capabilityId === 'target_power' && !ownsTargetPowerWrite(controlGeneration)) return true;
      // Store the admitted watt ceiling before handing control to Homey: a
      // driver may immediately apply its saved target when the mode changes.
      if (write.capabilityId === 'target_power' && takingControl) {
        invalidateSupersededTarget(write, reportRevision, requestedAtMs);
        await setCapability('target_power_mode', 'homey');
      }
      if (reassertingTargetPower && ownsTargetPowerWrite(controlGeneration)) {
        requiresTargetPowerReassertion = false;
        // A retained target may have kept receiving fresh poll timestamps
        // during Manual control. Only this newly issued target reclaims it.
        if (reportRevision === targetPowerReportRevision) {
          invalidateTargetPower(requestedAtMs);
        }
      }
      return true;
    },
    observeCapabilityUpdate(capabilityId, value) {
      if (!capabilities.includes(capabilityId)) return;
      if (capabilityId === 'target_power') targetPowerReportRevision += 1;
      capabilityObj = withNativeCapabilityObservation(capabilityObj, capabilityId, value);
    },
    observePowerControlMode(mode) {
      if (powerControlMode !== mode) powerControlModeGeneration += 1;
      if (mode === undefined && powerControlMode !== undefined) {
        requiresTargetPowerReassertion = false;
        targetPowerInvalidatedAtMs = undefined;
      }
      if (powerControlMode === 'manual' && mode === 'automatic'
          && isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj })) {
        requiresTargetPowerReassertion = true;
        targetPowerInvalidatedAtMs = Math.max(targetPowerInvalidatedAtMs ?? 0, Date.now());
      }
      powerControlMode = mode;
    },
    projectObservation(snapshot) {
      if (usesManualCurrentRoute()) return snapshot;
      if (snapshot.automaticPowerControl?.mode === 'automatic') {
        observeAutomaticProfile(snapshot.automaticPowerControl.profile);
      }
      if (!requiresTargetPowerReassertion && (targetPowerInvalidatedAtMs === undefined
          || (snapshot.reportedStepObservedAtMs !== undefined
            && snapshot.reportedStepObservedAtMs > targetPowerInvalidatedAtMs))) return snapshot;
      const {
        reportedStepId: _supersededStep,
        reportedStepPowerW: _supersededPower,
        reportedStepObservedAtMs: _supersededAt,
        ...retained
      } = snapshot;
      // This is a dated invalidation, never a new watt reading. Carrying its
      // epoch keeps the refresh merge from restoring the superseded rung.
      return { ...retained, reportedStepObservedAtMs: targetPowerInvalidatedAtMs };
    },
    getReportedStepId(profile, config) {
      if (requiresTargetPowerReassertion) return undefined;
      return resolveAdapterReportedStep(raw, capabilityObj, profile, config);
    },
  };
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

function getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as DeviceCapabilityMap
    : {};
}

function needsTargetPowerTakeover(capabilities: string[], capabilityObj: DeviceCapabilityMap): boolean {
  return capabilities.includes('target_power_mode')
    && capabilityObj.target_power_mode?.setable === true
    && capabilityObj.target_power_mode.value !== 'homey';
}
