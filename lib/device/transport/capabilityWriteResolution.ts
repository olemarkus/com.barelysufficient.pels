import { isBinarySwitchCapability } from '../../../packages/shared-domain/src/settings/deviceBinarySwitches';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import { getDeviceAdapter, getSnapshotAdapter } from '../deviceAdapterRegistry';
import type { CapabilityWrite, SwitchWrite } from '../deviceAdapter';
import type { EvChargingCurrentLimitPolicy } from '../evChargingCurrentLimitPolicy';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { OwnCapabilityWrite } from './ownCapabilityWrites';
import type { TransportSnapshotStore } from './transportSnapshotStore';

/** Temperature dispatch was refused, or the binding changed before the write answered. */
export const TEMPERATURE_WRITE_NOT_APPLIED = Symbol('temperature_write_not_applied');

export function normalizeCapabilityValue(
  snapshot: TransportDeviceSnapshot | undefined, id: string, value: unknown,
): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const target = snapshot?.targets.find((entry) => entry.id === id);
  return target ? normalizeTargetCapabilityValue({ target, value }) : value;
}

export function targetsBinarySwitch(snapshot: TransportDeviceSnapshot | undefined, id: string): boolean {
  return id === 'evcharger_charging' || isBinarySwitchCapability(id) || id === snapshot?.binaryCapabilityId;
}

export function captureBinaryWriteAuthority(
  snapshot: TransportDeviceSnapshot | undefined, id: string,
): OwnCapabilityWrite['binaryAuthority'] {
  return snapshot?.binaryCapabilityId === id ? { generation: snapshot.binarySwitchGeneration } : undefined;
}

export function readBackFromSnapshot(snapshot: TransportDeviceSnapshot | undefined): boolean {
  return !snapshot || getSnapshotAdapter(snapshot).readBackAfterWrite;
}

/**
 * Where a write to a device's binary switch lands in the SDK: the switch, or the
 * capability the transport routes it to. An Easee may carry out its charging
 * switch through the charger current instead (`resolveEaseeSwitchWrite`).
 * The settle evidence PELS waits for stays on the switch it asked for, and only
 * the switch is recorded as PELS's own write: an Easee current's echo is always an
 * observation (`nativeSteppedRealtime.ts`). An Easee under built-in control reads
 * its switch from the plug state and the current, not from what Homey holds for
 * it, so PELS's own write to the switch is no observation of it either. A
 * request the device needs no command for (an Easee session the car completed,
 * with built-in control off) sends nothing.
 */
export function resolveSdkWrite(
  snapshot: TransportDeviceSnapshot | undefined, raw: HomeyDeviceLike | undefined,
  requested: CapabilityWrite, policy: Pick<EvChargingCurrentLimitPolicy, 'projectSwitchSnapshot'>,
): SwitchWrite {
  if (snapshot?.binaryCapabilityId === requested.capabilityId) {
    const projected = policy.projectSwitchSnapshot(snapshot);
    return raw ? getDeviceAdapter(raw).recoverSwitchWrite(projected, raw, requested)
      : getSnapshotAdapter(projected).switchWrite(projected, requested);
  }
  const write = raw ? getDeviceAdapter(raw).capabilityWrite(raw, requested) : requested;
  return { kind: 'write', write, readBackAsWritten: true };
}

type CapabilityWriteRoute = {
  homeyDeviceId: string;
  raw: HomeyDeviceLike | undefined;
  temperatureAuthority?: OwnCapabilityWrite['temperatureAuthority'];
  targetStillCurrent: () => boolean;
};

/** Resolve the logical device's command to the physical device owning that capability. */
export function resolveCapabilityWriteRoute(
  store: TransportSnapshotStore,
  deviceId: string,
  capabilityId: string,
  snapshot: TransportDeviceSnapshot | undefined,
  generation: number | undefined,
): CapabilityWriteRoute | undefined {
  const thermostats = store.externalThermostats;
  if (capabilityId === 'target_temperature' && hasExternalTarget(store, deviceId, snapshot, generation)) {
    if (generation === undefined || snapshot?.temperature?.target.temperatureBindingGeneration !== generation) {
      return undefined;
    }
    const donorId = thermostats?.resolveWrite(deviceId, generation);
    if (donorId === undefined) return undefined;
    return {
      homeyDeviceId: donorId,
      raw: store.getLastAcceptedRawDevice(donorId),
      temperatureAuthority: { deviceId, generation },
      targetStillCurrent: () => thermostats?.resolveWrite(deviceId, generation) === donorId,
    };
  }
  const targetStillCurrent = () => capabilityId !== 'target_temperature'
    || thermostats?.allowsNativeTemperatureWrite(deviceId) !== false;
  if (!targetStillCurrent()) return undefined;
  return {
    homeyDeviceId: store.sourceDeviceId(deviceId),
    raw: store.getTrackedRawDevice(deviceId),
    targetStillCurrent,
  };
}

function hasExternalTarget(
  store: TransportSnapshotStore,
  deviceId: string,
  snapshot: TransportDeviceSnapshot | undefined,
  generation: number | undefined,
): boolean {
  return generation !== undefined || store.externalThermostats?.donorFor(deviceId) !== undefined
    || snapshot?.externalThermostatDonorId !== undefined;
}
