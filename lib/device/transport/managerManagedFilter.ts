import type { DeviceTransportParseProviders, ParseDevicePurpose } from './managerParseDevice';

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

export function shouldDropEarly(params: {
  purpose: ParseDevicePurpose;
  decision: ManagedFilterDecision;
}): boolean {
  const { purpose, decision } = params;
  if (purpose === 'unfiltered') return false;
  if (purpose === 'runtime') {
    if (!decision.filterActive) return false;
    return !decision.isManaged;
  }
  // ui_picker: drop only when there's nothing to pick from. Defer the
  // managed/unmanaged split to the late gate (after control-state parse) so
  // managed devices with a malformed `onoff` stay reachable through the
  // picker — otherwise a user could not toggle them back off.
  return !decision.hasOracle || !decision.filterActive;
}

export function shouldDropAfterControlState(params: {
  purpose: ParseDevicePurpose;
  decision: ManagedFilterDecision;
  currentOn: boolean | undefined;
}): boolean {
  const { purpose, decision, currentOn } = params;
  if (purpose !== 'ui_picker') return currentOn === undefined;
  // Drop well-formed managed devices in the picker — they are already in the
  // runtime snapshot. Keep managed devices whose `currentOn` is undefined so
  // the user can still toggle them back off through the picker.
  return decision.isManaged && currentOn !== undefined;
}
