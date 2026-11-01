import type { SteppedLoadProfile, TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../utils/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';
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

  /** Keep superseded targets out of fresh parses as well as mode-event reads. */
  projectObservation(snapshot: TransportDeviceSnapshot): TransportDeviceSnapshot {
    return this.adapters.get(snapshot.id)?.projectObservation(snapshot) ?? snapshot;
  }

  getReportedStepId(
    deviceId: string, profile: SteppedLoadProfile, config: TargetPowerSteppedLoadConfig | undefined,
  ): string | undefined {
    return this.adapters.get(deviceId)?.getReportedStepId(profile, config);
  }
}

function buildCapabilityNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
): NativeSteppedLoadCommandAdapter {
  let raw = device;
  let capabilities = Array.isArray(device.capabilities) ? [...device.capabilities] : [];
  let capabilityObj = getCapabilityObj(device);
  let targetPowerInvalidatedAtMs: number | undefined;
  let targetPowerReportRevision = 0;
  const retainTargetPowerEvidence = (next: DeviceCapabilityMap): DeviceCapabilityMap => {
    if (targetPowerInvalidatedAtMs === undefined) return next;
    const current = capabilityObj.target_power;
    const currentAt = toCapabilityTimestampMs(current?.lastUpdated);
    const nextAt = toCapabilityTimestampMs(next.target_power?.lastUpdated);
    if (nextAt !== undefined && nextAt > targetPowerInvalidatedAtMs
        && (currentAt === undefined || nextAt >= currentAt)) return next;
    if (current && currentAt !== undefined && currentAt > targetPowerInvalidatedAtMs) {
      return { ...next, target_power: { ...next.target_power,
        value: current.value, lastUpdated: current.lastUpdated } };
    }
    // Retain the capability's writable range, but no superseded value. A mode
    // report alone must not turn that former target back into step evidence.
    const { value: _superseded, ...target } = next.target_power ?? {};
    return { ...next, target_power: target };
  };
  return {
    syncDevice(nextDevice) {
      raw = nextDevice;
      capabilities = Array.isArray(nextDevice.capabilities) ? [...nextDevice.capabilities] : [];
      capabilityObj = retainTargetPowerEvidence(getCapabilityObj(nextDevice));
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
      const write = getDeviceAdapter(raw).stepCommand(raw, step, command);
      const takingControl = needsTargetPowerTakeover(capabilities, capabilityObj);
      const requestedAtMs = Date.now();
      const reportRevision = targetPowerReportRevision;
      await setCapability(write.capabilityId, write.value);
      // A driver may report its actual bounded target during dispatch, even
      // within the same millisecond. That report already replaced the old cap.
      if (write.capabilityId === 'target_power' && takingControl
          && reportRevision === targetPowerReportRevision
          && !Object.is(capabilityObj.target_power?.value, write.value)
          && (toCapabilityTimestampMs(capabilityObj.target_power?.lastUpdated) ?? 0) <= requestedAtMs) {
        targetPowerInvalidatedAtMs = Math.max(targetPowerInvalidatedAtMs ?? 0, requestedAtMs);
        capabilityObj = retainTargetPowerEvidence(capabilityObj);
      }
      // Store the admitted watt ceiling before handing control to Homey: a
      // driver may immediately apply its saved target when the mode changes.
      if (write.capabilityId === 'target_power' && takingControl) {
        await setCapability('target_power_mode', 'homey');
      }
      return true;
    },
    observeCapabilityUpdate(capabilityId, value) {
      if (!capabilities.includes(capabilityId)) return;
      if (capabilityId === 'target_power') targetPowerReportRevision += 1;
      capabilityObj = {
        ...capabilityObj,
        [capabilityId]: {
          ...capabilityObj[capabilityId],
          value,
          ...(capabilityId === 'target_power' ? { lastUpdated: new Date().toISOString() } : {}),
        },
      };
    },
    projectObservation(snapshot) {
      if (targetPowerInvalidatedAtMs === undefined
          || (snapshot.reportedStepObservedAtMs !== undefined
            && snapshot.reportedStepObservedAtMs > targetPowerInvalidatedAtMs)) return snapshot;
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
      const target = capabilityObj.target_power;
      const values = config && typeof target?.value === 'number'
        ? { ...capabilityObj, target_power: { ...target,
          value: getDeviceAdapter(raw).targetPowerReading(raw, config, target.value) } }
        : capabilityObj;
      return resolveNativeSteppedLoadReportedStepId({
        profile,
        capabilities,
        capabilityObj: values,
      });
    },
  };
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
