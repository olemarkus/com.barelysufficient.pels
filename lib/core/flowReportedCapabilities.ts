import type { DeviceCapabilityMap, DeviceCapabilityValue } from './deviceManagerControl';

export const FLOW_REPORTED_CAPABILITY_IDS = [
  'onoff',
  'measure_power',
  'evcharger_charging',
  'evcharger_charging_state',
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

const BINARY_REQUIRED_CAPABILITIES: readonly FlowReportedCapabilityId[] = ['onoff', 'measure_power'];
const EV_REQUIRED_CAPABILITIES: readonly FlowReportedCapabilityId[] = [
  'evcharger_charging',
  'evcharger_charging_state',
  'measure_power',
];

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

export function resolveFlowAugmentedDeviceType(params: {
  deviceClassKey: string;
  targetCapabilityIds: readonly string[];
}): FlowAugmentedDeviceType {
  const { deviceClassKey, targetCapabilityIds } = params;
  if (deviceClassKey === 'evcharger') return 'evcharger';
  if (targetCapabilityIds.length > 0) return 'unsupported';
  return 'binary';
}

export function getFlowRequiredCapabilitiesForType(
  deviceType: FlowAugmentedDeviceType,
): readonly FlowReportedCapabilityId[] {
  if (deviceType === 'binary') return BINARY_REQUIRED_CAPABILITIES;
  if (deviceType === 'evcharger') return EV_REQUIRED_CAPABILITIES;
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

  const allowedCapabilityIds = getFlowRequiredCapabilitiesForType(deviceType);
  const nextCapabilities = new Set(capabilities);
  const nextCapabilityObj: DeviceCapabilityMap = { ...capabilityObj };
  const flowBackedCapabilityIds: FlowReportedCapabilityId[] = [];

  for (const capabilityId of allowedCapabilityIds) {
    const reportedEntry = reportedCapabilities[capabilityId];
    if (!reportedEntry) continue;

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

  const rawCapabilityLastUpdatedMs = resolveCapabilityLastUpdatedMs(rawCapability);
  if (rawCapabilityPresent && rawCapability && rawCapabilityLastUpdatedMs !== undefined
    && rawCapabilityLastUpdatedMs >= reportedEntry.reportedAt) {
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

function resolveCapabilityLastUpdatedMs(value: DeviceCapabilityValue | undefined): number | undefined {
  const rawValue = value?.lastUpdated;
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : undefined;
  }
  if (rawValue instanceof Date) {
    const parsed = rawValue.getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (typeof rawValue === 'string') {
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(rawValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
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
  if (capabilityId === 'evcharger_charging_state') {
    return typeof value === 'string';
  }
  return typeof value === 'boolean';
}
