import { getDeviceAdapter, getCapabilityAdapter } from './deviceAdapterRegistry';
export { isNativeSteppedLoadControlEnabled } from './deviceAdapter';
export type { CapabilityWrite } from './deviceAdapter';
import type { CapabilityWrite } from './deviceAdapter';
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
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { buildTargetPowerLadderSteps } from '../../packages/shared-domain/src/targetPowerLadder';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';


const NATIVE_STEPPED_LOAD_CAPABILITY_IDS = [
  'max_power_3000',
  'max_power_2000',
  'max_power',
  // myUplink's Connected 120 and Connected Retrofit. Their element wattages
  // vary by installation, so they have no fixed ladder below.
  'max_power_2elem',
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

/** Canonical amp observation used by EV target-power profiles. */
export const AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID = 'available_installation_current';

const NATIVE_VALUES_BY_RANK = {
  low: ['low_power', '1', 1],
  medium: ['medium_power', '2', 2],
  high: ['high_power', '3', 3],
} as const;

// Høiax apps disagree on the enum ids of `max_power_*`: some declare
// `'1' | '2' | '3'`, the `no.hoiax` app declares `low_power | medium_power |
// high_power` and rejects anything else with HTTP 400.
const NATIVE_WRITE_VALUES_BY_RANK = {
  low: { numeric: '1', named: 'low_power' },
  medium: { numeric: '2', named: 'medium_power' },
  high: { numeric: '3', named: 'high_power' },
} as const;

export const CONNECTED_300_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

export const CONNECTED_200_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 700 },
    { id: 'medium', planningPowerW: 1300 },
    { id: 'max', planningPowerW: 2000 },
  ],
};

const FIXED_HOIAX_LADDERS: Partial<Record<NativeSteppedLoadCapabilityId, SteppedLoadProfile>> = {
  max_power_3000: CONNECTED_300_STEPPED_LOAD_PROFILE,
  max_power_2000: CONNECTED_200_STEPPED_LOAD_PROFILE,
  max_power: CONNECTED_200_STEPPED_LOAD_PROFILE,
};

// A Høiax heater reports the wattage of each of its two elements. The myUplink
// app publishes them as read-only labels such as "1250W" (heater points 504
// and 503); the no.hoiax app as `HeaterNomPower` and `HeaterNomPower2`.
const HOIAX_ELEMENT_POWER_SETTING_PAIRS = [
  ['status_504', 'status_503'],
  ['HeaterNomPower', 'HeaterNomPower2'],
] as const;
const MAX_HOIAX_ELEMENT_POWER_W = 6000;
const HOIAX_ELEMENT_POWER_TEXT = /^\s*(\d+(?:\.\d+)?)\s*w?\s*$/iu;

function readHoiaxElementPowerW(value: unknown): number | undefined {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;
  const match = text === undefined ? null : HOIAX_ELEMENT_POWER_TEXT.exec(text);
  const watts = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isFinite(watts) && watts > 0 && watts <= MAX_HOIAX_ELEMENT_POWER_W ? watts : undefined;
}

/**
 * The ladder the heater's own element wattages give: low runs the smaller
 * element, medium the larger, max both. The apps number the two elements
 * differently, so the levels are ordered by wattage rather than by point.
 * Two equal elements give one single-element rung.
 */
function resolveHoiaxElementLadder(device: HomeyDeviceLike): SteppedLoadProfile | undefined {
  const pair = HOIAX_ELEMENT_POWER_SETTING_PAIRS
    .map(([firstKey, secondKey]) => [
      readHoiaxElementPowerW(device.settings[firstKey]),
      readHoiaxElementPowerW(device.settings[secondKey]),
    ] as const)
    .find((watts): watts is readonly [number, number] => watts[0] !== undefined && watts[1] !== undefined);
  if (!pair) return undefined;
  const lowW = Math.min(...pair);
  const mediumW = Math.max(...pair);
  const steps: SteppedLoadStep[] = [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: lowW },
    { id: 'medium', planningPowerW: mediumW },
    { id: 'max', planningPowerW: lowW + mediumW },
  ];
  return { steps: mediumW > lowW ? steps : steps.filter((step) => step.id !== 'medium') };
}

/** A Høiax heater's ladder, or none when its power levels cannot be sized. */
function resolveHoiaxSteppedLoadProfile(
  device: HomeyDeviceLike,
  capabilities: readonly string[],
): SteppedLoadProfile | undefined {
  if (!isHoiaxDevice(device)) return undefined;
  const capabilityId = resolveNativeSteppedLoadCapabilityId(capabilities);
  if (capabilityId === undefined) return undefined;
  return resolveHoiaxElementLadder(device) ?? FIXED_HOIAX_LADDERS[capabilityId];
}

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
  if (resolveHoiaxSteppedLoadProfile(device, capabilities) !== undefined) return true;
  if (capabilityObj !== undefined && getDeviceAdapter(device).nativeCurrentControls
    .some((control) => control.accepts(device, capabilityObj))) return true;
  return isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj });
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
 *   - Easee chargers          → `target_charger_current` (off step writes 0 A),
 *     plus the app's `setDynamicChargerCurrent` Flow card, which is the same
 *     write. It is a card id rather than a capability id, but a user Flow's
 *     device card is recorded under the same `homey:device:<id>:<suffix>` key,
 *     so the classifier intersects it like any other owned write.
 *
 * Operates on the capability-id list alone (no `capabilityObj`): callers pass
 * the capabilities of a device already classified as a stepped-load candidate
 * (`controlModel === 'stepped_load'`), so target_power setability is already
 * resolved upstream. Returns `[]` when no native-write capability is present.
 *
 * This is the canonical owned-native-write set used by the flow-conflict
 * detection (notes/native-wiring/): a user Flow writing any of these for the
 * same device conflicts with PELS taking the device over natively.
 *
 * `onoff` is not in it, although built-in control writes it for a Hoiax off
 * step: PELS switches a managed device on and off with built-in control off
 * as well, so a Flow that only switches it is not made safe by holding
 * built-in control back, and pausing it would only cost the power levels the
 * Flow never touches.
 */
export function resolveNativeSteppedLoadWriteCapabilities(
  capabilities: readonly string[],
): string[] {
  if (capabilities.includes(TARGET_POWER_CAPABILITY_ID)) return [TARGET_POWER_CAPABILITY_ID];
  const current = getCapabilityAdapter(capabilities).nativeCurrentControls
    .find((control) => capabilities.includes(control.capabilityId));
  if (current) return [...current.writeCapabilities];

  const nativeCapabilityId = resolveNativeSteppedLoadCapabilityId(capabilities);
  if (!nativeCapabilityId) return [];

  return [nativeCapabilityId];
}

/**
 * Whether a native-write set (`resolveNativeSteppedLoadWriteCapabilities`)
 * belongs to a device whose native control sits behind the owner-visible
 * "built-in device control" switch, and so is auto-enabled only when no user
 * Flow already does the same write: Hoiax `max_power_*` and Easee charger
 * current. `target_power` steppers are default-on with no switch, so they are
 * not gated.
 */
export function isToggleGatedNativeWriteSet(ownedCapabilities: readonly string[]): boolean {
  return ownedCapabilities.some((capabilityId) => (
    getCapabilityAdapter(ownedCapabilities).nativeCurrentControls
      .some((control) => control.capabilityId === capabilityId)
    || NATIVE_STEPPED_LOAD_CAPABILITY_SET.has(capabilityId)
  ));
}

export function resolveNativeSteppedLoadProfileSuggestion(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): SteppedLoadProfile | undefined {
  if (!isNativeSteppedLoadWiringCandidate(params)) return undefined;
  const hoiaxProfile = resolveHoiaxSteppedLoadProfile(params.device, params.capabilities);
  if (hoiaxProfile) return hoiaxProfile;
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
  const current = getCapabilityAdapter(capabilities).nativeCurrentControls
    .find((control) => capabilities.includes(control.capabilityId));
  if (current) return current.stepObservations(profile, capabilityObj)[0];
  const capabilityId = resolveNativeSteppedLoadCapabilityId(capabilities);
  if (!capabilityId && isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj })) {
    return resolveTargetPowerReportedStepId(profile, capabilities, capabilityObj);
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
}): CapabilityWrite | null {
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

  const current = getCapabilityAdapter(capabilities).nativeCurrentControls
    .find((control) => capabilities.includes(control.capabilityId));
  if (current) {
    if (desiredStep.planningCurrentA === undefined) return null;
    return { capabilityId: current.capabilityId, value: Math.round(desiredStep.planningCurrentA) };
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
    value: resolveNativeValueForRank(rank, params.capabilityObj?.[capabilityId]),
  };
}

export function isNativeSteppedLoadControlCapabilityId(params: {
  capabilityId: string;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): boolean {
  if (resolveNativeSteppedLoadCapabilityId([params.capabilityId]) !== undefined) return true;
  if (
    getCapabilityAdapter(params.capabilities).nativeCurrentControls
      .some((control) => control.capabilityId === params.capabilityId)
  ) {
    return true;
  }
  return params.capabilityId === TARGET_POWER_CAPABILITY_ID
    && isTargetPowerSteppedLoadCandidate(params);
}

export function resolveNativeSteppedLoadObservationCapabilityId(params: {
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): string | undefined {
  const current = getCapabilityAdapter(params.capabilities).nativeCurrentControls
    .find((control) => params.capabilities.includes(control.capabilityId));
  if (current) return current.capabilityId;
  return resolveNativeSteppedLoadCapabilityId(params.capabilities)
    ?? (
      isTargetPowerSteppedLoadCandidate(params)
        ? TARGET_POWER_CAPABILITY_ID
        : undefined
    );
}

function isHoiaxDevice(device: HomeyDeviceLike): boolean {
  if (HOIAX_OWNER_URIS.has(normalizeText(device.ownerUri))) return true;
  const driverId = normalizeText(device.driverId);
  return HOIAX_DRIVER_IDS.has(driverId)
    || HOIAX_DRIVER_ID_PREFIXES.some((prefix) => driverId.startsWith(prefix));
}

export function isTargetPowerSteppedLoadCandidate(params: {
  capabilities: readonly string[];
  capabilityObj?: Partial<DeviceCapabilityMap>;
}): boolean {
  const targetPower = params.capabilityObj?.[TARGET_POWER_CAPABILITY_ID];
  return params.capabilities.includes(TARGET_POWER_CAPABILITY_ID)
    && targetPower?.setable === true;
}

/** A published watt ladder can replace configuration only when it is usable. */
export function hasNativeTargetPowerLadder(
  capabilities: readonly string[], capabilityObj: Partial<DeviceCapabilityMap>,
): boolean {
  return resolveNativeTargetPowerLadder(capabilities, capabilityObj) !== undefined;
}

export function resolveNativeTargetPowerLadder(
  capabilities: readonly string[], capabilityObj: Partial<DeviceCapabilityMap>,
): SteppedLoadProfile | undefined {
  return isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj })
    ? withUsableLadder(buildCapabilityTargetPowerSteppedLoadProfile(capabilityObj.target_power)) : undefined;
}

/** Integrations can derive a ladder from native amps as well as native watts. */
export function resolveAutomaticSteppedLoadProfile(
  device: HomeyDeviceLike, capabilities: readonly string[], capabilityObj: DeviceCapabilityMap,
): SteppedLoadProfile | undefined {
  const nativeWatts = resolveNativeTargetPowerLadder(capabilities, capabilityObj);
  if (nativeWatts) return nativeWatts;
  const current = getDeviceAdapter(device).nativeCurrentControls
    .find((control) => capabilities.includes(control.capabilityId) && control.accepts(device, capabilityObj));
  return current ? withUsableLadder(current.automaticProfile(device, capabilityObj)) : undefined;
}

function resolveTargetPowerSteppedLoadProfileSuggestion(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj?: DeviceCapabilityMap;
}): SteppedLoadProfile | undefined {
  if (!isTargetPowerSteppedLoadCandidate(params)) return undefined;
  const nativeProfile = buildCapabilityTargetPowerSteppedLoadProfile(params.capabilityObj?.target_power);
  if (nativeProfile) return nativeProfile;
  const preset = resolveTargetPowerPreset(params.device);
  if (preset === 'ev_charger_1_phase' || preset === 'ev_charger_3_phase') {
    return buildEvTargetPowerCandidateProfile({ preset });
  }
  return undefined;
}

function resolveTargetPowerPreset(device: HomeyDeviceLike): TargetPowerPreset | undefined {
  const { settings } = device;
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
  return steps ? { steps } : undefined;
}

export function resolveTargetPowerReportedStepId(
  profile: SteppedLoadProfile,
  capabilities: readonly string[],
  capabilityObj: DeviceCapabilityMap,
): string | undefined {
  // A switchable device's saved watt target is dormant under device control.
  // It cannot confirm that PELS's requested step has been applied.
  if (!isTargetPowerControlActive(capabilityObj, capabilities)) return undefined;
  const targetPowerValue = capabilityObj.target_power?.value;
  if (typeof targetPowerValue !== 'number' || !Number.isFinite(targetPowerValue)) return undefined;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  if (targetPowerValue <= 0) {
    return sortedSteps.find((step) => isSteppedLoadOffStep(profile, step.id))?.id;
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

export function isTargetPowerControlActive(
  capabilityObj: DeviceCapabilityMap, capabilities: readonly string[],
): boolean {
  if (!capabilities.includes('target_power_mode')) return true;
  const mode = capabilityObj.target_power_mode;
  if (mode?.value !== 'homey' && mode?.value !== 'device') return false;
  return mode.setable !== true || mode.value === 'homey';
}

/** A source-dated invalidation of the saved target, never fresh watt evidence. */
export function resolveTargetPowerModeInvalidationAtMs(
  capabilityObj: DeviceCapabilityMap, capabilities: readonly string[],
): number | undefined {
  if (isTargetPowerControlActive(capabilityObj, capabilities)) return undefined;
  const mode = capabilityObj.target_power_mode;
  if (mode?.value !== 'device') return undefined;
  return toCapabilityTimestampMs(mode.lastUpdated);
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

/**
 * The enum id the device itself uses for `rank`: its declared enum ids first,
 * then the convention of the value it reports, then the numeric ids.
 */
function resolveNativeValueForRank(
  rank: Exclude<NativeStepRank, 'off'>,
  capability: unknown,
): string {
  const { numeric, named } = NATIVE_WRITE_VALUES_BY_RANK[rank];
  const declaredIds = readDeclaredEnumIds(capability);
  if (declaredIds.has(named)) return named;
  if (declaredIds.has(numeric)) return numeric;
  if (declaredIds.size === 0 && isNamedNativeValue(readCapabilityValue(capability))) return named;
  return numeric;
}

function readDeclaredEnumIds(capability: unknown): Set<string> {
  if (!isRecord(capability) || !Array.isArray(capability.values)) return new Set();
  return new Set(capability.values
    .map((entry: unknown) => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined))
    .filter((id): id is string => id !== undefined));
}

function readCapabilityValue(capability: unknown): unknown {
  return isRecord(capability) ? capability.value : undefined;
}

function isNamedNativeValue(value: unknown): boolean {
  return Object.values(NATIVE_WRITE_VALUES_BY_RANK).some(({ named }) => named === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
