import type { DeviceTransportParseProviders, ParseDevicePurpose } from './managerParseDevice';
import { isBatteryOrSolarClassKey } from './managerHelpers';

export type ManagedFilterDecision = {
  hasOracle: boolean;
  filterActive: boolean;
  isManaged: boolean;
};

export function resolveManagedFilterDecision(params: {
  providers: DeviceTransportParseProviders;
  deviceId: string;
}): ManagedFilterDecision {
  const { providers, deviceId } = params;
  if (providers.getManaged === undefined) {
    return { hasOracle: false, filterActive: false, isManaged: false };
  }
  return {
    hasOracle: true,
    filterActive: providers.isManagedFilterActive?.() ?? true,
    isManaged: providers.getManaged(deviceId) === true,
  };
}

/**
 * "Tracked": the runtime keeps this device in its snapshot and on its realtime
 * feed. A managed device is tracked, and so is a home battery whatever its
 * Managed setting: a battery PELS still holds must stay readable, and its
 * claim and power must keep updating, for it to be handed back. The planner,
 * not the transport, decides that an unmanaged battery is ignored. The one
 * predicate both the snapshot filter (`shouldDropEarly`) and realtime tracking
 * (`DeviceSnapshotReader.shouldTrackRealtimeDevice`) answer with.
 */
export function isRuntimeTrackedDevice(decision: ManagedFilterDecision, isHomeBattery: boolean): boolean {
  return !decision.hasOracle || decision.isManaged || isHomeBattery;
}

export function shouldDropEarly(
  purpose: ParseDevicePurpose,
  decision: ManagedFilterDecision,
  isHomeBattery: boolean,
): boolean {
  if (purpose === 'runtime') {
    if (!decision.filterActive) return false;
    return !isRuntimeTrackedDevice(decision, isHomeBattery);
  }
  // ui_picker: drop only when there's nothing to pick from. Defer the
  // managed/unmanaged split to the late gate (after control-state parse),
  // which is where `currentOn` is known. (A malformed `onoff` never gets this
  // far: the device-read contract ignores that read before any parse.)
  return !decision.hasOracle || !decision.filterActive;
}

export function shouldDropAfterControlState(params: {
  purpose: ParseDevicePurpose;
  decision: ManagedFilterDecision;
  currentOn: boolean | undefined;
  deviceClassKey?: string;
}): boolean {
  const { purpose, decision, currentOn, deviceClassKey } = params;
  // A home battery or solar device has no on/off control capability, so its
  // `currentOn` is legitimately `undefined`.
  //   - RUNTIME: keep it (it rides the runtime snapshot for SoC/power or production
  //     tracking) — it must NOT be dropped on the `currentOn === undefined` basis.
  //   - UI PICKER: drop it. The runtime snapshot always carries it (a battery is
  //     tracked whatever its Managed setting, a solar device is always read), so
  //     dropping it here keeps it rendered exactly once in the settings UI, never
  //     twice.
  if (isBatteryOrSolarClassKey(deviceClassKey)) return purpose === 'ui_picker';
  if (purpose !== 'ui_picker') return currentOn === undefined;
  // Drop managed devices with a resolved `currentOn` in the picker — they are
  // already in the runtime snapshot. One whose `currentOn` is undefined is not
  // (the runtime gate above drops it), so the picker keeps it reachable.
  return decision.isManaged && currentOn !== undefined;
}
