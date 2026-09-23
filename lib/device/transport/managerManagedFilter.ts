import type { DeviceTransportParseProviders, ParseDevicePurpose } from './managerParseDevice';
import { isObserveOnlyRoleClassKey } from './managerHelpers';

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
  // A home battery or solar device is a FORCE-MANAGED observe-only device with no
  // on/off control capability, so its `currentOn` is legitimately `undefined`.
  //   - RUNTIME: keep it (it rides the managed snapshot for SoC/power or production
  //     tracking) — it must NOT be dropped on the `currentOn === undefined` basis.
  //   - UI PICKER: drop it. The picker offers devices the user can opt into managing;
  //     an observe-only device is always managed, so its "manage" toggle is a no-op.
  //     Dropping it here keeps it OUT of the unmanaged-eligible picker list, so it
  //     renders exactly once in the settings UI (the managed list), never twice.
  if (isObserveOnlyRoleClassKey(deviceClassKey)) return purpose === 'ui_picker';
  if (purpose !== 'ui_picker') return currentOn === undefined;
  // Drop managed devices with a resolved `currentOn` in the picker — they are
  // already in the runtime snapshot. One whose `currentOn` is undefined is not
  // (the runtime gate above drops it), so the picker keeps it reachable.
  return decision.isManaged && currentOn !== undefined;
}
