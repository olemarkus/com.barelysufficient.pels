import type { TargetDeviceSnapshot } from '../utils/types';
import type { DeviceCapabilityMap } from './deviceManagerControl';

const TARGET_CAPABILITY_PREFIXES = ['target_temperature'];
const POWER_CAPABILITY_PREFIXES = ['measure_power', 'meter_power'] as const;
const POWER_CAPABILITY_SET = new Set(POWER_CAPABILITY_PREFIXES);

export function resolveDeviceCapabilities(params: {
  deviceClassKey: string;
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  logDebug: (...args: unknown[]) => void;
}): { targetCaps: string[]; hasPower: boolean } | null {
  const {
    deviceClassKey,
    deviceId,
    deviceLabel,
    capabilities,
    logDebug,
  } = params;
  const hasPower = hasPowerCapability(capabilities);
  const targetCaps = getTargetCaps(capabilities);
  const hasOnOff = capabilities.includes('onoff');
  if (deviceClassKey === 'evcharger') {
    if (!capabilities.includes('evcharger_charging')) {
      logDebug(
        `Skipping EV charger ${deviceLabel} (${deviceId}), missing evcharger_charging. Capabilities: ${capabilities.join(', ')}`,
      );
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

export function getCapabilityValueByPrefix(
  capabilities: string[],
  capabilityObj: DeviceCapabilityMap,
  prefix: (typeof POWER_CAPABILITY_PREFIXES)[number],
): unknown {
  if (capabilities.includes(prefix)) {
    const direct = capabilityObj[prefix]?.value;
    if (direct !== undefined) return direct;
  }
  const capId = capabilities.find((cap) => cap === prefix || cap.startsWith(`${prefix}.`));
  return capId ? capabilityObj[capId]?.value : undefined;
}

export function getCurrentTemperature(capabilityObj: DeviceCapabilityMap): number | undefined {
  const temp = capabilityObj.measure_temperature?.value;
  return typeof temp === 'number' ? temp : undefined;
}

export function buildTargets(
  targetCaps: string[],
  capabilityObj: DeviceCapabilityMap,
): TargetDeviceSnapshot['targets'] {
  return targetCaps.map((capId) => ({
    id: capId,
    value: capabilityObj[capId]?.value ?? null,
    unit: capabilityObj[capId]?.units || '°C',
  }));
}

function hasPowerCapability(capabilities: string[]): boolean {
  return capabilities.some((cap) => (
    POWER_CAPABILITY_SET.has(cap as (typeof POWER_CAPABILITY_PREFIXES)[number])
    || POWER_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(`${prefix}.`))
  ));
}

function getTargetCaps(capabilities: string[]): string[] {
  return capabilities.filter((cap) => TARGET_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(prefix)));
}
