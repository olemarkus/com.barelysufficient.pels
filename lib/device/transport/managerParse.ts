import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { DeviceCapabilityMap } from '../managerControl';

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
    if (!capabilities.includes('evcharger_charging_state')) {
      debugStructured?.({
        event: 'device_skipped_missing_capability',
        deviceClass: deviceClassKey,
        deviceId,
        deviceName: deviceLabel,
        missingCapability: 'evcharger_charging_state',
        capabilities,
      });
      return null;
    }
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

function hasPowerCapability(capabilities: string[]): boolean {
  return capabilities.some((cap) => POWER_CAPABILITY_SET.has(cap as PowerCapabilityId));
}

function getTargetCaps(capabilities: string[]): string[] {
  return capabilities.filter((cap) => TARGET_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(prefix)));
}
