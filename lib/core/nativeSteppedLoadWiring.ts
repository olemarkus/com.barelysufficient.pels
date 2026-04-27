import type {
  DeviceControlAdapterSnapshot,
  HomeyDeviceLike,
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../utils/types';
import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
  sortSteppedLoadSteps,
} from '../utils/deviceControlProfiles';
import type { DeviceCapabilityMap } from './deviceManagerControl';

export const NATIVE_STEPPED_LOAD_CAPABILITY_IDS = [
  'max_power_3000',
  'max_power_2000',
  'max_power',
] as const;

export type NativeSteppedLoadCapabilityId = (typeof NATIVE_STEPPED_LOAD_CAPABILITY_IDS)[number];
type NativeStepRank = 'off' | 'low' | 'medium' | 'high';

const NATIVE_STEPPED_LOAD_CAPABILITY_SET = new Set<string>(NATIVE_STEPPED_LOAD_CAPABILITY_IDS);
const HOIAX_OWNER_URIS = new Set(['homey:app:no.hoiax']);
const HOIAX_DRIVER_ID_PREFIXES = [
  'homey:app:no.hoiax:',
  'no.hoiax:',
] as const;
const HOIAX_DRIVER_IDS = new Set([
  'homey:app:com.myuplink:hoiax',
  'com.myuplink:hoiax',
]);

const NATIVE_VALUES_BY_RANK = {
  low: ['low_power', '1', 1],
  medium: ['medium_power', '2', 2],
  high: ['high_power', '3', 3],
} as const;

const NATIVE_WRITE_VALUE_BY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
} as const;

export const CONNECTED_300_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

export const CONNECTED_200_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 700 },
    { id: 'medium', planningPowerW: 1300 },
    { id: 'max', planningPowerW: 2000 },
  ],
};

export function resolveNativeSteppedLoadCapabilityId(
  capabilities: readonly string[],
): NativeSteppedLoadCapabilityId | undefined {
  return NATIVE_STEPPED_LOAD_CAPABILITY_IDS.find((capabilityId) => capabilities.includes(capabilityId));
}

export function isNativeSteppedLoadWiringCandidate(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
}): boolean {
  const { device, capabilities } = params;
  return isHoiaxDevice(device) && resolveNativeSteppedLoadCapabilityId(capabilities) !== undefined;
}

export function resolveNativeSteppedLoadProfileSuggestion(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
}): SteppedLoadProfile | undefined {
  if (!isNativeSteppedLoadWiringCandidate(params)) return undefined;
  if (params.capabilities.includes('max_power_3000')) return CONNECTED_300_STEPPED_LOAD_PROFILE;
  if (params.capabilities.includes('max_power_2000') || params.capabilities.includes('max_power')) {
    return CONNECTED_200_STEPPED_LOAD_PROFILE;
  }
  return undefined;
}

export function stripNativeSteppedLoadControlCapabilities(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
}): string[] {
  if (!isHoiaxDevice(params.device)) return [...params.capabilities];
  return params.capabilities.filter((capabilityId) => !NATIVE_STEPPED_LOAD_CAPABILITY_SET.has(capabilityId));
}

export function buildNativeSteppedLoadControlAdapter(params: {
  nativeWiringEnabled: boolean;
}): DeviceControlAdapterSnapshot {
  return {
    kind: 'capability_adapter',
    activationAvailable: true,
    activationRequired: false,
    activationEnabled: params.nativeWiringEnabled,
  };
}

export function resolveNativeSteppedLoadReportedStepId(params: {
  profile: SteppedLoadProfile;
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
}): string | undefined {
  const {
    profile,
    capabilities,
    capabilityObj,
  } = params;
  const capabilityId = resolveNativeSteppedLoadCapabilityId(capabilities);
  const rank = capabilityId
    ? normalizeNativeStepRank(capabilityObj[capabilityId]?.value)
    : undefined;
  if (rank) return resolveStepIdForRank(profile, rank);
  if (capabilityObj.onoff?.value === false) {
    return resolveStepIdForRank(profile, 'off');
  }
  return undefined;
}

export function resolveNativeSteppedLoadCommand(params: {
  profile: SteppedLoadProfile;
  desiredStepId: string;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): { capabilityId: string; value: unknown } | null {
  const {
    profile,
    desiredStepId,
    capabilities,
  } = params;
  const desiredStep = getSteppedLoadStep(profile, desiredStepId);
  if (!desiredStep) return null;

  if (isSteppedLoadOffStep(profile, desiredStep.id)) {
    return capabilities.includes('onoff') ? { capabilityId: 'onoff', value: false } : null;
  }

  const capabilityId = resolveNativeSteppedLoadCapabilityId(capabilities);
  if (!capabilityId) return null;
  const rank = resolveRankForStep(profile, desiredStep);
  if (rank === 'off') return null;
  return {
    capabilityId,
    value: resolveNativeValueForRank(rank),
  };
}

export function isNativeSteppedLoadControlEnabled(snapshot: {
  controlAdapter?: DeviceControlAdapterSnapshot;
}): boolean {
  return snapshot.controlAdapter?.activationAvailable === true
    && snapshot.controlAdapter.activationEnabled === true;
}

function isHoiaxDevice(device: HomeyDeviceLike): boolean {
  const ownerUri = normalizeText(device.ownerUri ?? device.driver?.owner_uri);
  if (HOIAX_OWNER_URIS.has(ownerUri)) return true;
  const driverUri = normalizeText(device.driverUri ?? device.driver?.uri);
  if (HOIAX_OWNER_URIS.has(driverUri)) return true;
  const driverId = normalizeText(device.driverId ?? device.driver?.id);
  return HOIAX_DRIVER_IDS.has(driverId)
    || HOIAX_DRIVER_ID_PREFIXES.some((prefix) => driverId.startsWith(prefix));
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveRankForStep(profile: SteppedLoadProfile, step: SteppedLoadStep): NativeStepRank {
  if (isSteppedLoadOffStep(profile, step.id)) return 'off';
  const positiveSteps = sortSteppedLoadSteps(profile.steps)
    .filter((candidate) => !isSteppedLoadOffStep(profile, candidate.id));
  const index = positiveSteps.findIndex((candidate) => candidate.id === step.id);
  if (positiveSteps.length === 1) return 'high';
  if (index <= 0) return 'low';
  if (index >= positiveSteps.length - 1) return 'high';
  return 'medium';
}

function resolveStepIdForRank(profile: SteppedLoadProfile, rank: NativeStepRank): string | undefined {
  if (rank === 'off') {
    return sortSteppedLoadSteps(profile.steps)
      .find((step) => isSteppedLoadOffStep(profile, step.id))
      ?.id;
  }
  const positiveSteps = sortSteppedLoadSteps(profile.steps)
    .filter((step) => !isSteppedLoadOffStep(profile, step.id));
  if (positiveSteps.length === 0) return undefined;
  if (rank === 'low') return positiveSteps[0]?.id;
  if (rank === 'high') return positiveSteps.at(-1)?.id;
  if (positiveSteps.length <= 2) return positiveSteps.at(-1)?.id;
  return positiveSteps[Math.floor((positiveSteps.length - 1) / 2)]?.id;
}

function normalizeNativeStepRank(value: unknown): Exclude<NativeStepRank, 'off'> | undefined {
  for (const [rank, values] of Object.entries(NATIVE_VALUES_BY_RANK)) {
    if (values.some((candidate) => Object.is(candidate, value))) {
      return rank as Exclude<NativeStepRank, 'off'>;
    }
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  }
  return undefined;
}

function resolveNativeValueForRank(
  rank: Exclude<NativeStepRank, 'off'>,
): unknown {
  return NATIVE_WRITE_VALUE_BY_RANK[rank];
}
