import type { EvChargingState, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { DeviceCapabilityMap } from '../managerControl';
import { isObserveOnlyRoleClassKey } from './managerHelpers';

const TARGET_CAPABILITY_PREFIXES = ['target_temperature'];
const POWER_CAPABILITY_PREFIXES = ['measure_power', 'meter_power'] as const;
const POWER_CAPABILITY_SET = new Set(POWER_CAPABILITY_PREFIXES);
export type PowerCapabilityId = (typeof POWER_CAPABILITY_PREFIXES)[number];

export function resolveDeviceCapabilities(params: {
  deviceClassKey: string;
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  debugStructured?: StructuredDebugEmitter;
}): { targetCaps: string[]; hasPower: boolean } | null {
  const {
    deviceClassKey,
    deviceId,
    deviceLabel,
    capabilities,
    debugStructured,
  } = params;
  const hasPower = hasPowerCapability(capabilities);
  const targetCaps = getTargetCaps(capabilities);
  const hasOnOff = capabilities.includes('onoff');
  // A home battery or solar device has neither a temperature target nor `onoff` (PELS
  // never controls it), so it would otherwise be dropped by the no-control gate below.
  // Keep it as a power-capable, NON-controllable snapshot entry: it rides the managed
  // snapshot as a managed observe-only device (battery SoC + charge/discharge power, or
  // PV production tracked), and the existing control gates keep it inert.
  if (isObserveOnlyRoleClassKey(deviceClassKey)) {
    return { targetCaps: [], hasPower };
  }
  if (deviceClassKey === 'evcharger') {
    if (!capabilities.includes('evcharger_charging')) {
      debugStructured?.({
        event: 'device_skipped_missing_capability',
        deviceClass: deviceClassKey,
        deviceId,
        deviceName: deviceLabel,
        missingCapability: 'evcharger_charging',
        capabilities,
      });
      return null;
    }
    // `evcharger_charging_state` is required of every EV charger and is checked
    // ahead of this, in `resolveCandidateCapabilities` — including for the chargers
    // that bypass this function entirely on the control axis.
    return { targetCaps: [], hasPower };
  }
  if (targetCaps.length > 0 && !capabilities.includes('measure_temperature')) {
    return null;
  }
  if (targetCaps.length === 0 && !hasOnOff) {
    return null;
  }
  return { targetCaps, hasPower };
}


/**
 * Contract gate for the EV plug-state capability, sibling to the
 * missing-capability drops above: `evcharger_charging_state` is a closed Homey
 * enum, so a device that CLAIMS it must report a member of that enum. One that
 * does not is not implementing the capability, and is dropped from the snapshot
 * exactly as a device missing the capability is — which is what lets every layer
 * downstream treat a present `evChargingState` as valid, and never need a policy
 * for an unreadable one.
 *
 * Every EV charger reaches this gate: `resolveCandidateCapabilities` requires
 * `evcharger_charging_state` of every `evcharger` ahead of both control-axis
 * bypasses, because `target_power` / stepped-load is the amp/step axis and not a
 * substitute for the state axis. The capability check here is what keeps the gate
 * inert for the non-EV devices that also flow through this parse path.
 *
 * Two absences, deliberately treated differently, discriminated on whether the
 * payload carries the capability ENTRY — not on whether its value is non-null,
 * since `null` is itself an invalid report rather than a missing one:
 *  - the payload REPORTS the capability with a non-enum value (including `null`)
 *    → violation, drop even when an older valid value is retained (keeping it
 *    would strand a stale plug-state that no longer describes the charger);
 *  - the payload OMITS the capability entry → an ordinary partial `device.update`,
 *    not a violation. The retained observation stands; drop only if there has
 *    never been one. Dropping on the payload alone would evict a healthy charger
 *    on every partial update.
 */
export function shouldDropForEvPlugStateContract(params: {
  deviceClassKey: string;
  deviceId: string;
  deviceLabel: string;
  capabilities: readonly string[];
  /** True when the payload carries the capability entry at all — see the docblock. */
  stateReportedInPayload: boolean;
  reportedStateValue: unknown;
  evChargingState: EvChargingState | undefined;
  retainedEvChargingState: EvChargingState | undefined;
  debugStructured?: StructuredDebugEmitter;
}): boolean {
  const {
    deviceClassKey, deviceId, deviceLabel, capabilities, stateReportedInPayload,
    reportedStateValue, evChargingState, retainedEvChargingState, debugStructured,
  } = params;
  if (!capabilities.includes('evcharger_charging_state')) return false;
  const hasContractualState = stateReportedInPayload
    ? evChargingState !== undefined
    : retainedEvChargingState !== undefined;
  if (hasContractualState) return false;
  debugStructured?.({
    event: 'device_skipped_invalid_capability_value',
    deviceClass: deviceClassKey,
    deviceId,
    deviceName: deviceLabel,
    capabilityId: 'evcharger_charging_state',
    rawValue: reportedStateValue ?? null,
  });
  return true;
}

export function getExactPowerCapabilityValue(
  capabilities: readonly string[],
  capabilityObj: DeviceCapabilityMap,
  capabilityId: PowerCapabilityId,
): unknown {
  if (capabilities.includes(capabilityId)) {
    const direct = capabilityObj[capabilityId]?.value;
    if (direct !== undefined) return direct;
  }
  return undefined;
}

export function getCurrentTemperature(capabilityObj: DeviceCapabilityMap): number | undefined {
  const temp = capabilityObj.measure_temperature?.value;
  return typeof temp === 'number' && Number.isFinite(temp) ? temp : undefined;
}

export function buildTargets(
  params: {
    targetCaps: string[];
    capabilityObj: DeviceCapabilityMap;
    deviceId?: string;
    deviceLabel: string;
    debugStructured?: StructuredDebugEmitter;
  },
): TargetDeviceSnapshot['targets'] {
  const {
    targetCaps,
    capabilityObj,
    deviceId,
    deviceLabel,
    debugStructured,
  } = params;
  return targetCaps.map((capId) => {
    const capability = capabilityObj[capId];
    const value = capability?.value;
    const resolvedValue = resolveTargetCapabilityValue({
      value,
      capId,
      deviceId,
      deviceLabel,
      debugStructured,
    });
    return {
      id: capId,
      ...(resolvedValue !== undefined ? { value: resolvedValue } : {}),
      unit: capability?.units || '°C',
      ...finiteCapabilityNumber('min', capability?.min),
      ...finiteCapabilityNumber('max', capability?.max),
      ...finiteCapabilityNumber('step', capability?.step),
      ...finiteCapabilityNumber('excludeMin', capability?.excludeMin),
      ...finiteCapabilityNumber('excludeMax', capability?.excludeMax),
    };
  });
}

function finiteCapabilityNumber<T extends 'min' | 'max' | 'step' | 'excludeMin' | 'excludeMax'>(
  key: T,
  value: unknown,
): Partial<Record<T, number>> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { [key]: value } as Partial<Record<T, number>>
    : {};
}

function resolveTargetCapabilityValue(params: {
  value: unknown;
  capId: string;
  deviceId?: string;
  deviceLabel: string;
  debugStructured?: StructuredDebugEmitter;
}): number | undefined {
  const {
    value,
    capId,
    deviceId,
    deviceLabel,
    debugStructured,
  } = params;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  debugStructured?.({
    event: 'target_capability_value_malformed',
    ...(deviceId !== undefined ? { deviceId } : {}),
    deviceName: deviceLabel,
    capabilityId: capId,
    rawValue: String(value),
  });
  return undefined;
}

// Exported so the settings API's whole-home meter picker offers exactly the
// devices the runtime considers power-capable (measure_power or meter_power).
export function hasPowerCapability(capabilities: string[]): boolean {
  return capabilities.some((cap) => POWER_CAPABILITY_SET.has(cap as PowerCapabilityId));
}

function getTargetCaps(capabilities: string[]): string[] {
  return capabilities.filter((cap) => TARGET_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(prefix)));
}
