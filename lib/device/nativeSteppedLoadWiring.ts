import type {
  DeviceControlAdapterSnapshot,
  SteppedLoadProfile,
  SteppedLoadStep,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../utils/types';
import {
  buildEvTargetPowerCandidateProfile,
  isEvTargetPowerConfig,
  resolveEvTargetPowerConfirmedMaxPowerW,
  resolveEvTargetPowerConfirmedProfile,
} from './targetPowerReachability';
import {
  getSteppedLoadStep,
  hasUsableSteppedLoadLadder,
  isSteppedLoadOffStep,
  sortSteppedLoadSteps,
} from '../utils/deviceControlProfiles';
import { buildTargetPowerLadderSteps } from '../../packages/shared-domain/src/targetPowerLadder';
import type { DeviceCapabilityMap } from './managerControl';

export const NATIVE_STEPPED_LOAD_CAPABILITY_IDS = [
  'max_power_3000',
  'max_power_2000',
  'max_power',
] as const;

export type NativeSteppedLoadCapabilityId = (typeof NATIVE_STEPPED_LOAD_CAPABILITY_IDS)[number];
type NativeStepRank = 'off' | 'low' | 'medium' | 'high';
type TargetPowerPreset = 'ev_charger_1_phase' | 'ev_charger_3_phase';

const NATIVE_STEPPED_LOAD_CAPABILITY_SET = new Set<string>(NATIVE_STEPPED_LOAD_CAPABILITY_IDS);
export const TARGET_POWER_CAPABILITY_ID = 'target_power';
const TARGET_POWER_PRESET_SETTING_KEYS = [
  'pelsTargetPowerPreset',
  'pels_target_power_preset',
] as const;
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
  low: '1',
  medium: '2',
  high: '3',
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
  capabilityObj?: DeviceCapabilityMap;
}): boolean {
  const { device, capabilities, capabilityObj } = params;
  if (isHoiaxDevice(device) && resolveNativeSteppedLoadCapabilityId(capabilities) !== undefined) return true;
  return isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj });
}

export function isTargetPowerSteppedLoadWiringCandidate(params: {
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): boolean {
  return isTargetPowerSteppedLoadCandidate(params);
}

export function hasTargetPowerCapability(capabilities: readonly string[]): boolean {
  return capabilities.includes(TARGET_POWER_CAPABILITY_ID);
}

/**
 * The capabilities PELS writes when it natively drives a stepped-load device,
 * mirroring `resolveNativeSteppedLoadCommand`'s write targets:
 *   - target_power steppers  → `target_power` (off step writes 0, same cap)
 *   - max_power_* steppers    → the present `max_power_*` cap, plus `onoff`
 *     when the device exposes it (the off step writes `onoff:false`)
 *
 * Operates on the capability-id list alone (no `capabilityObj`): callers pass
 * the capabilities of a device already classified as a stepped-load candidate
 * (`controlModel === 'stepped_load'`), so target_power setability is already
 * resolved upstream. Returns `[]` when no native-write capability is present.
 *
 * This is the canonical owned-native-write set used by the flow-conflict
 * detection (notes/native-wiring/): a user Flow writing any of these for the
 * same device conflicts with PELS taking the device over natively.
 */
export function resolveNativeSteppedLoadWriteCapabilities(
  capabilities: readonly string[],
): string[] {
  if (capabilities.includes(TARGET_POWER_CAPABILITY_ID)) return [TARGET_POWER_CAPABILITY_ID];

  const nativeCapabilityId = resolveNativeSteppedLoadCapabilityId(capabilities);
  if (!nativeCapabilityId) return [];

  return capabilities.includes('onoff') ? [nativeCapabilityId, 'onoff'] : [nativeCapabilityId];
}

export function resolveNativeSteppedLoadProfileSuggestion(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): SteppedLoadProfile | undefined {
  if (!isNativeSteppedLoadWiringCandidate(params)) return undefined;
  if (params.capabilities.includes('max_power_3000')) return CONNECTED_300_STEPPED_LOAD_PROFILE;
  if (params.capabilities.includes('max_power_2000') || params.capabilities.includes('max_power')) {
    return CONNECTED_200_STEPPED_LOAD_PROFILE;
  }
  return withUsableLadder(resolveTargetPowerSteppedLoadProfileSuggestion(params));
}

/**
 * Stepped control derived from a target-power config: the config and the ladder
 * it drives, or nothing.
 *
 * The two travel together on purpose. This used to hand back an optional
 * profile beside a config the caller had already accepted, so a range that
 * produced no ladder still left the device wearing a target-power config —
 * classified as a stepped load with nowhere to stand. There is no such state
 * now: a device either has stepped control with rungs on it, or has no stepped
 * control at all and falls through to whatever other axis it exposes (and, if
 * it has none, out of the snapshot entirely — `resolveDeviceCapabilities`).
 *
 * `undefined` here means "not a stepped load", never "stepped, ladder pending".
 */
export type TargetPowerSteppedControl = {
  config: TargetPowerSteppedLoadConfig;
  profile: SteppedLoadProfile;
};

export function resolveTargetPowerSteppedControl(
  config: TargetPowerSteppedLoadConfig | undefined,
  observedPowerW?: number,
): TargetPowerSteppedControl | undefined {
  if (!config || config.enabled === false) return undefined;
  const profile = isEvTargetPowerConfig(config)
    ? resolveEvTargetPowerConfirmedProfile(config, observedPowerW)
    : buildCapabilityTargetPowerSteppedLoadProfile(config);
  // Belt-and-braces against the range validation in
  // `normalizeTargetPowerSteppedLoadConfig`, which every config reaching here
  // has already passed, and against an EV preset whose confirmed ceiling has
  // collapsed below its lowest rung.
  const usableProfile = withUsableLadder(profile);
  return usableProfile ? { config, profile: usableProfile } : undefined;
}

const withUsableLadder = (
  profile: SteppedLoadProfile | undefined,
): SteppedLoadProfile | undefined => (
  hasUsableSteppedLoadLadder(profile) ? profile : undefined
);

export function buildSyntheticTargetPowerCapabilityMap(params: {
  capabilityObj: DeviceCapabilityMap;
  config: TargetPowerSteppedLoadConfig;
  observedValue?: number;
  observedAt?: DeviceCapabilityMap[string]['lastUpdated'];
}): DeviceCapabilityMap {
  const currentTargetPower = params.capabilityObj[TARGET_POWER_CAPABILITY_ID];
  const resolvedMax = isEvTargetPowerConfig(params.config)
    ? resolveEvTargetPowerConfirmedMaxPowerW(params.config, params.observedValue)
    : params.config.max;
  return {
    ...params.capabilityObj,
    [TARGET_POWER_CAPABILITY_ID]: {
      ...currentTargetPower,
      min: params.config.min,
      max: resolvedMax,
      step: params.config.step,
      excludeMin: params.config.excludeMin,
      excludeMax: params.config.excludeMax,
      setable: currentTargetPower?.setable === true,
      value: params.observedValue ?? currentTargetPower?.value,
      lastUpdated: params.observedAt ?? currentTargetPower?.lastUpdated,
      units: 'W',
    },
  };
}

export function stripNativeSteppedLoadControlCapabilities(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): string[] {
  return params.capabilities.filter((capabilityId) => {
    if (isHoiaxDevice(params.device) && NATIVE_STEPPED_LOAD_CAPABILITY_SET.has(capabilityId)) return false;
    return !(capabilityId === TARGET_POWER_CAPABILITY_ID && isTargetPowerSteppedLoadCandidate(params));
  });
}

export function buildNativeSteppedLoadControlAdapter(params: {
  nativeWiringEnabled: boolean;
  activationAvailable?: boolean;
}): DeviceControlAdapterSnapshot {
  return {
    kind: 'capability_adapter',
    activationAvailable: params.activationAvailable ?? true,
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
  if (!capabilityId && isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj })) {
    return resolveTargetPowerReportedStepId({ profile, capabilityObj });
  }
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

  if (isTargetPowerSteppedLoadCandidate(params)) {
    return {
      capabilityId: TARGET_POWER_CAPABILITY_ID,
      value: Math.round(desiredStep.planningPowerW),
    };
  }

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
  return snapshot.controlAdapter?.kind === 'capability_adapter'
    && snapshot.controlAdapter.activationAvailable !== undefined
    && snapshot.controlAdapter.activationEnabled === true;
}

export function isNativeSteppedLoadControlCapabilityId(params: {
  capabilityId: string;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): boolean {
  if (resolveNativeSteppedLoadCapabilityId([params.capabilityId]) !== undefined) return true;
  return params.capabilityId === TARGET_POWER_CAPABILITY_ID
    && isTargetPowerSteppedLoadCandidate(params);
}

export function resolveNativeSteppedLoadObservationCapabilityId(params: {
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): string | undefined {
  return resolveNativeSteppedLoadCapabilityId(params.capabilities)
    ?? (
      isTargetPowerSteppedLoadCandidate(params)
        ? TARGET_POWER_CAPABILITY_ID
        : undefined
    );
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

function isTargetPowerSteppedLoadCandidate(params: {
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): boolean {
  const targetPower = params.capabilityObj?.[TARGET_POWER_CAPABILITY_ID];
  return params.capabilities.includes(TARGET_POWER_CAPABILITY_ID)
    && targetPower?.setable === true;
}

function resolveTargetPowerSteppedLoadProfileSuggestion(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): SteppedLoadProfile | undefined {
  if (!isTargetPowerSteppedLoadCandidate(params)) return undefined;
  const preset = resolveTargetPowerPreset(params.device);
  if (preset === 'ev_charger_1_phase' || preset === 'ev_charger_3_phase') {
    return buildEvTargetPowerCandidateProfile({ preset });
  }
  return buildCapabilityTargetPowerSteppedLoadProfile(params.capabilityObj?.target_power);
}

function resolveTargetPowerPreset(device: HomeyDeviceLike): TargetPowerPreset | undefined {
  const settings = device.settings;
  if (!settings) return undefined;
  for (const key of TARGET_POWER_PRESET_SETTING_KEYS) {
    const value = settings[key];
    if (value === 'ev_charger_1_phase' || value === 'ev_charger_3_phase') return value;
  }
  return undefined;
}

function buildCapabilityTargetPowerSteppedLoadProfile(
  capability: Pick<DeviceCapabilityMap[string], 'min' | 'max' | 'step' | 'excludeMax'> | undefined,
): SteppedLoadProfile | undefined {
  const steps = buildTargetPowerLadderSteps(capability);
  return steps ? { model: 'stepped_load', steps } : undefined;
}

export function resolveTargetPowerReportedStepId(params: {
  profile: SteppedLoadProfile;
  capabilityObj: DeviceCapabilityMap;
}): string | undefined {
  const targetPowerValue = params.capabilityObj.target_power?.value;
  if (typeof targetPowerValue !== 'number' || !Number.isFinite(targetPowerValue)) return undefined;
  const sortedSteps = sortSteppedLoadSteps(params.profile.steps);
  if (targetPowerValue <= 0) {
    return sortedSteps.find((step) => isSteppedLoadOffStep(params.profile, step.id))?.id;
  }
  let nearestStep: SteppedLoadStep | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const step of sortedSteps) {
    const distance = Math.abs(step.planningPowerW - targetPowerValue);
    if (distance < nearestDistance) {
      nearestStep = step;
      nearestDistance = distance;
    }
  }
  return nearestStep?.id;
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
