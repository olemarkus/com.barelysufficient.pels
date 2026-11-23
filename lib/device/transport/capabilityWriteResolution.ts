import { isBinarySwitchCapability } from '../../../packages/shared-domain/src/settings/deviceBinarySwitches';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import { getDeviceAdapter, getSnapshotAdapter } from '../deviceAdapterRegistry';
import type { CapabilityWrite, SwitchWrite } from '../deviceAdapter';
import type { EvChargingCurrentLimitPolicy } from '../evChargingCurrentLimitPolicy';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { OwnCapabilityWrite } from './ownCapabilityWrites';

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
