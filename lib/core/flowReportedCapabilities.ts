import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceCapabilityMap, DeviceCapabilityValue } from './deviceManagerControl';
import { getCapabilities, resolveDeviceClassKey } from './deviceManagerHelpers';

export const FLOW_REPORTED_CAPABILITY_IDS = [
  'onoff',
  'measure_power',
  'evcharger_charging',
  'alarm_generic.car_connected',
] as const;

export type FlowReportedCapabilityId = (typeof FLOW_REPORTED_CAPABILITY_IDS)[number];

export type FlowReportedCapabilityEntry = {
  value: boolean | number | string;
  reportedAt: number;
  source: 'flow';
};

export type FlowReportedCapabilitiesByDevice = Partial<
  Record<string, Partial<Record<FlowReportedCapabilityId, FlowReportedCapabilityEntry>>>
>;
export type FlowReportedCapabilitiesForDevice = Partial<Record<FlowReportedCapabilityId, FlowReportedCapabilityEntry>>;

type FlowAugmentedDeviceType = 'binary' | 'evcharger' | 'unsupported';

const FLOW_REPORTED_CAPABILITY_SET = new Set<string>(FLOW_REPORTED_CAPABILITY_IDS);

const BINARY_INPUT_CAPABILITIES: readonly FlowReportedCapabilityId[] = ['onoff', 'measure_power'];
const EV_INPUT_CAPABILITIES: readonly FlowReportedCapabilityId[] = [
  'evcharger_charging',
  'alarm_generic.car_connected',
  'measure_power',
];
const BINARY_EFFECTIVE_REQUIRED_CAPABILITIES = ['onoff', 'measure_power'] as const;
const EV_EFFECTIVE_REQUIRED_CAPABILITIES = [
  'evcharger_charging',
  'evcharger_charging_state',
  'measure_power',
] as const;
type FlowEffectiveRequiredCapabilityId =
  | (typeof BINARY_EFFECTIVE_REQUIRED_CAPABILITIES)[number]
  | (typeof EV_EFFECTIVE_REQUIRED_CAPABILITIES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

function isSupportedReportedCapabilityId(value: string): value is FlowReportedCapabilityId {
  return FLOW_REPORTED_CAPABILITY_SET.has(value);
}

export function parseFlowReportedCapabilities(value: unknown): FlowReportedCapabilitiesByDevice {
  if (!isRecord(value)) return {};

  const parsed: FlowReportedCapabilitiesByDevice = {};
  for (const [deviceId, deviceEntry] of Object.entries(value)) {
    if (!isRecord(deviceEntry)) continue;
    const nextDeviceEntry = parseFlowReportedDeviceEntry(deviceEntry);

    if (Object.keys(nextDeviceEntry).length > 0) {
      parsed[deviceId] = nextDeviceEntry;
    }
  }

  return parsed;
}

export function upsertFlowReportedCapability(params: {
  state: FlowReportedCapabilitiesByDevice;
  deviceId: string;
  capabilityId: FlowReportedCapabilityId;
  value: boolean | number | string;
  reportedAt?: number;
}): 'changed' | 'unchanged' {
  const {
    state,
    deviceId,
    capabilityId,
    value,
    reportedAt = Date.now(),
  } = params;
  const current = state[deviceId]?.[capabilityId];
  const nextEntry: FlowReportedCapabilityEntry = {
    value,
    reportedAt,
    source: 'flow',
  };

  state[deviceId] = {
    ...(state[deviceId] ?? {}),
    [capabilityId]: nextEntry,
  };

  return current && Object.is(current.value, value) ? 'unchanged' : 'changed';
}

export function getFlowReportedDeviceIds(state: FlowReportedCapabilitiesByDevice | undefined): string[] {
  return Object.keys(state ?? {});
}

export function getFlowRefreshRequestedDeviceIds(params: {
  state: FlowReportedCapabilitiesByDevice | undefined;
  devices: HomeyDeviceLike[];
  experimentalEvSupportEnabled: boolean;
  candidateDeviceIds?: readonly string[];
}): string[] {
  const {
    state,
    devices,
    experimentalEvSupportEnabled,
    candidateDeviceIds,
  } = params;
  if (!state) return [];

  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const deviceIds = candidateDeviceIds ?? Object.keys(state);

  return deviceIds.filter((deviceId) => {
    const reportedCapabilities = state[deviceId];
    if (!reportedCapabilities) return false;

    const device = deviceById.get(deviceId);
    if (!device) return false;

    const deviceClassKey = resolveDeviceClassKey({
      device,
      experimentalEvSupportEnabled,
    });
    if (!deviceClassKey) return false;

    const capabilities = getCapabilities(device);
    const targetCapabilityIds = capabilities.filter((capabilityId) => capabilityId.startsWith('target_temperature'));
    const deviceType = resolveFlowAugmentedDeviceType({
      deviceClassKey,
      targetCapabilityIds,
    });
    if (deviceType === 'unsupported') return false;

    return getFlowInputCapabilitiesForType(deviceType).some((capabilityId) => (
      reportedCapabilities[capabilityId] && !isCapabilityProvidedNatively(capabilityId, capabilities)
    ));
  });
}

export function resolveFlowAugmentedDeviceType(params: {
  deviceClassKey: string;
  targetCapabilityIds: readonly string[];
}): FlowAugmentedDeviceType {
  const { deviceClassKey, targetCapabilityIds } = params;
  if (deviceClassKey === 'evcharger') return 'evcharger';
  if (targetCapabilityIds.length > 0) return 'unsupported';
  return 'binary';
}

export function getFlowInputCapabilitiesForType(
  deviceType: FlowAugmentedDeviceType,
): readonly FlowReportedCapabilityId[] {
  if (deviceType === 'binary') return BINARY_INPUT_CAPABILITIES;
  if (deviceType === 'evcharger') return EV_INPUT_CAPABILITIES;
  return [];
}

export function getFlowEffectiveRequiredCapabilitiesForType(
  deviceType: FlowAugmentedDeviceType,
): readonly FlowEffectiveRequiredCapabilityId[] {
  if (deviceType === 'binary') return BINARY_EFFECTIVE_REQUIRED_CAPABILITIES;
  if (deviceType === 'evcharger') return EV_EFFECTIVE_REQUIRED_CAPABILITIES;
  return [];
}

export function augmentCapabilitiesWithFlowReports(params: {
  deviceType: FlowAugmentedDeviceType;
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: Partial<Record<FlowReportedCapabilityId, FlowReportedCapabilityEntry>>;
}): {
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
} {
  const {
    deviceType,
    capabilities,
    capabilityObj,
    reportedCapabilities,
  } = params;
  if (deviceType === 'unsupported') {
    return {
      capabilities: [...capabilities],
      capabilityObj: { ...capabilityObj },
      flowBackedCapabilityIds: [],
    };
  }

  const allowedCapabilityIds = getFlowInputCapabilitiesForType(deviceType);
  const nextCapabilities = new Set(capabilities);
  const nextCapabilityObj: DeviceCapabilityMap = { ...capabilityObj };
  const flowBackedCapabilityIds: FlowReportedCapabilityId[] = [];

  for (const capabilityId of allowedCapabilityIds) {
    const reportedEntry = reportedCapabilities[capabilityId];
    if (!reportedEntry) continue;
    if (capabilities.includes(capabilityId)) continue;

    nextCapabilities.add(capabilityId);
    flowBackedCapabilityIds.push(capabilityId);

    const rawCapability = capabilityObj[capabilityId];
    nextCapabilityObj[capabilityId] = buildFlowBackedCapabilityValue({
      capabilityId,
      reportedEntry,
      rawCapability,
      rawCapabilityPresent: capabilities.includes(capabilityId),
    });
  }

  if (deviceType === 'evcharger' && !capabilities.includes('evcharger_charging_state')) {
    const derivedStateEntry = buildDerivedEvChargingStateEntry({
      capabilityObj: nextCapabilityObj,
      reportedCapabilities,
    });
    if (derivedStateEntry) {
      nextCapabilities.add('evcharger_charging_state');
      nextCapabilityObj.evcharger_charging_state = {
        ...(nextCapabilityObj.evcharger_charging_state ?? {}),
        value: derivedStateEntry.value,
        lastUpdated: derivedStateEntry.reportedAt,
      };
    }
  }

  return {
    capabilities: Array.from(nextCapabilities),
    capabilityObj: nextCapabilityObj,
    flowBackedCapabilityIds,
  };
}

function buildFlowBackedCapabilityValue(params: {
  capabilityId: FlowReportedCapabilityId;
  reportedEntry: FlowReportedCapabilityEntry;
  rawCapability: DeviceCapabilityValue | undefined;
  rawCapabilityPresent: boolean;
}): DeviceCapabilityValue {
  const {
    capabilityId,
    reportedEntry,
    rawCapability,
    rawCapabilityPresent,
  } = params;

  if (rawCapabilityPresent && rawCapability) {
    return { ...rawCapability };
  }

  const nextValue: DeviceCapabilityValue = {
    ...(rawCapability ?? {}),
    value: reportedEntry.value,
    lastUpdated: reportedEntry.reportedAt,
  };

  if (!rawCapabilityPresent && (capabilityId === 'onoff' || capabilityId === 'evcharger_charging')) {
    nextValue.setable = false;
  }

  return nextValue;
}

function buildDerivedEvChargingStateEntry(params: {
  capabilityObj: DeviceCapabilityMap;
  reportedCapabilities: Partial<Record<FlowReportedCapabilityId, FlowReportedCapabilityEntry>>;
}): FlowReportedCapabilityEntry | null {
  const { capabilityObj, reportedCapabilities } = params;
  const connectedValue = capabilityObj['alarm_generic.car_connected']?.value;
  const chargingValue = capabilityObj.evcharger_charging?.value;
  if (typeof connectedValue !== 'boolean' || typeof chargingValue !== 'boolean') {
    return null;
  }

  const connectedReportedAt = resolveCapabilityLastUpdatedMs(
    capabilityObj['alarm_generic.car_connected']?.lastUpdated,
    reportedCapabilities['alarm_generic.car_connected']?.reportedAt,
  );
  const chargingReportedAt = resolveCapabilityLastUpdatedMs(
    capabilityObj.evcharger_charging?.lastUpdated,
    reportedCapabilities.evcharger_charging?.reportedAt,
  );
  const reportedAt = Math.max(connectedReportedAt ?? 0, chargingReportedAt ?? 0);
  if (reportedAt <= 0) return null;

  let value: string;
  if (!connectedValue) {
    value = 'plugged_out';
  } else if (chargingValue) {
    value = 'plugged_in_charging';
  } else {
    value = 'plugged_in_paused';
  }

  return {
    value,
    reportedAt,
    source: 'flow',
  };
}

function resolveCapabilityLastUpdatedMs(
  rawLastUpdated: DeviceCapabilityValue['lastUpdated'],
  fallbackReportedAt?: number,
): number | undefined {
  if (rawLastUpdated instanceof Date) return rawLastUpdated.getTime();
  if (typeof rawLastUpdated === 'number' && Number.isFinite(rawLastUpdated)) return rawLastUpdated;
  if (typeof rawLastUpdated === 'string') {
    const parsed = Date.parse(rawLastUpdated);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof fallbackReportedAt === 'number' && Number.isFinite(fallbackReportedAt)
    ? fallbackReportedAt
    : undefined;
}

function parseFlowReportedDeviceEntry(
  deviceEntry: Record<string, unknown>,
): Partial<Record<FlowReportedCapabilityId, FlowReportedCapabilityEntry>> {
  const nextDeviceEntry: Partial<Record<FlowReportedCapabilityId, FlowReportedCapabilityEntry>> = {};

  for (const [capabilityId, rawEntry] of Object.entries(deviceEntry)) {
    if (!isSupportedReportedCapabilityId(capabilityId)) continue;
    const parsedEntry = parseFlowReportedEntry(capabilityId, rawEntry);
    if (parsedEntry) {
      nextDeviceEntry[capabilityId] = parsedEntry;
    }
  }

  return nextDeviceEntry;
}

function isCapabilityProvidedNatively(
  capabilityId: FlowReportedCapabilityId,
  capabilities: readonly string[],
): boolean {
  if (capabilityId === 'measure_power') {
    return capabilities.some((nativeCapabilityId) => (
      nativeCapabilityId === 'measure_power'
      || nativeCapabilityId.startsWith('measure_power.')
      || nativeCapabilityId === 'meter_power'
      || nativeCapabilityId.startsWith('meter_power.')
    ));
  }
  return capabilities.includes(capabilityId);
}

function parseFlowReportedEntry(
  capabilityId: FlowReportedCapabilityId,
  rawEntry: unknown,
): FlowReportedCapabilityEntry | null {
  if (!isRecord(rawEntry) || rawEntry.source !== 'flow' || !('value' in rawEntry)) {
    return null;
  }

  const reportedAt = Number(rawEntry.reportedAt);
  if (!Number.isFinite(reportedAt) || reportedAt <= 0) {
    return null;
  }

  if (!isValidFlowReportedValue(capabilityId, rawEntry.value)) {
    return null;
  }

  return {
    value: rawEntry.value,
    reportedAt,
    source: 'flow',
  };
}

function isValidFlowReportedValue(
  capabilityId: FlowReportedCapabilityId,
  value: unknown,
): value is boolean | number | string {
  if (capabilityId === 'measure_power') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === 'boolean';
}
