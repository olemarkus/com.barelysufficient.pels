import {
  getSteppedLoadHighestStep,
  normalizeDeviceControlProfiles,
  resolveSteppedLoadPlanningPowerKw,
} from '../../../contracts/src/deviceControlProfiles.ts';
import type {
  DeviceControlModel,
  DeviceTargetPowerConfigs,
  SteppedLoadProfile,
  TargetPowerSteppedLoadConfig,
} from '../../../contracts/src/types.ts';
import { DEVICE_CONTROL_PROFILES, DEVICE_TARGET_POWER_CONFIGS } from '../../../contracts/src/settingsKeys.ts';
import { resolveTargetPowerLadderIssue } from '../../../shared-domain/src/targetPowerLadder.ts';
import { getSetting } from './homey.ts';
import { state, type SettingsUiDeviceView } from './state.ts';
import { supportsTemperatureDevice } from './deviceUtils.ts';
import { logSettingsError } from './logging.ts';

const DEFAULT_MAX_PLANNING_POWER_W = 1500;
const roundPowerW = (value: number): number => Math.max(0, Math.round(value / 50) * 50);

const resolveEstimatedMaxPlanningPowerW = (
  // Reads the decoration's `planningPowerKw` when present (the live device list
  // is the decorated carrier); it is optional, so a device without it is valid.
  device: SettingsUiDeviceView,
): number => {
  const knownKw = [
    device.planningPowerKw,
    device.expectedPowerKw,
    device.measuredPowerKw,
  ].find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return roundPowerW((knownKw ?? (DEFAULT_MAX_PLANNING_POWER_W / 1000)) * 1000) || DEFAULT_MAX_PLANNING_POWER_W;
};

export const createDefaultSteppedLoadProfile = (device: SettingsUiDeviceView): SteppedLoadProfile => {
  if (device.suggestedSteppedLoadProfile) {
    return device.suggestedSteppedLoadProfile;
  }

  const maxPlanningPowerW = resolveEstimatedMaxPlanningPowerW(device);
  const lowPlanningPowerW = roundPowerW(Math.max(100, maxPlanningPowerW * 0.5));
  const steps = lowPlanningPowerW < maxPlanningPowerW
    ? [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: lowPlanningPowerW },
      { id: 'max', planningPowerW: maxPlanningPowerW },
    ]
    : [
      { id: 'off', planningPowerW: 0 },
      { id: 'max', planningPowerW: maxPlanningPowerW },
    ];
  return { steps };
};

export const getStoredDeviceControlProfile = (deviceId: string) => state.deviceControlProfiles[deviceId] ?? null;
export const getStoredTargetPowerConfig = (deviceId: string) => state.deviceTargetPowerConfigs[deviceId] ?? null;

export const isNativeSteppedLoadProfileActive = (device?: SettingsUiDeviceView | null): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && device.controlAdapter.activationEnabled === true
  && device.suggestedSteppedLoadProfile !== undefined
);

const hasResolvedSteppedLoadProfile = (device: SettingsUiDeviceView): boolean => (
  device.steppedLoadProfile !== undefined
  || getStoredDeviceControlProfile(device.id) !== null
);

const hasEnabledEvTargetPowerPreset = (device: SettingsUiDeviceView): boolean => {
  const targetPowerConfig = getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig;
  return targetPowerConfig?.enabled !== false
    && (targetPowerConfig?.preset === 'ev_charger_1_phase' || targetPowerConfig?.preset === 'ev_charger_3_phase');
};

/**
 * Is a stepped-load profile ACTUALLY governing this device right now?
 *
 * This is the UI's mirror of the runtime's own answer. `getSteppedLoadProfile`
 * (`setup/appDeviceControlHelpers.ts`) resolves the effective profile, and
 * `decorateTargetSnapshotList` runs that same resolution — target-power configs
 * first, then `resolveEffectiveSteppedLoadProfile` — before publishing the
 * snapshot this UI reads. So the decorated `steppedLoadProfile` IS the runtime's
 * verdict, and the other rungs only cover an edit this page is holding that the
 * runtime has not re-parsed yet: a locally saved control profile, a locally
 * enabled EV target-power preset, an observed native activation.
 *
 * What is deliberately NOT a rung: a bare `suggestedSteppedLoadProfile`. The
 * runtime honours a suggestion only once native activation is enabled or the
 * control model has actually been switched to stepped
 * (`resolveSuggestedSteppedLoadProfile` gates on `controlModel`), so a device
 * merely carrying one is still binary-controlled.
 */
export const isSteppedLoadProfileActive = (device?: SettingsUiDeviceView | null): boolean => {
  if (!device) return false;
  if (isNativeSteppedLoadProfileActive(device)) return true;
  if (hasResolvedSteppedLoadProfile(device)) return true;
  return hasEnabledEvTargetPowerPreset(device);
};

/**
 * May this device be OFFERED stepped controls? Wider than the predicate above by
 * exactly one rung — a native device carrying a suggested profile whose stepped
 * activation is still off. That device gets the step editor (turning activation
 * on is the point of the surface) while remaining binary-controlled everywhere
 * else, so do not use this to decide what a binary device may configure.
 */
export const hasSteppedLoadSupport = (device?: SettingsUiDeviceView | null): boolean => (
  isSteppedLoadProfileActive(device)
  || device?.suggestedSteppedLoadProfile !== undefined
);

export const getEffectiveControlModel = (device: SettingsUiDeviceView): DeviceControlModel => {
  if (isNativeSteppedLoadProfileActive(device)) return 'stepped_load';
  if (device.controlModel) return device.controlModel;
  const storedProfile = getStoredDeviceControlProfile(device.id);
  if (storedProfile) return 'stepped_load';
  const storedTargetPowerConfig = getStoredTargetPowerConfig(device.id);
  if (storedTargetPowerConfig && storedTargetPowerConfig.enabled !== false) return 'stepped_load';
  return supportsTemperatureDevice(device) ? 'temperature_target' : 'binary_power';
};

export const loadDeviceControlProfiles = async (): Promise<void> => {
  try {
    state.deviceControlProfiles = normalizeDeviceControlProfiles(await getSetting(DEVICE_CONTROL_PROFILES)) ?? {};
    state.deviceTargetPowerConfigs = normalizeDeviceTargetPowerConfigs(await getSetting(DEVICE_TARGET_POWER_CONFIGS));
  } catch (error) {
    state.deviceControlProfiles = {};
    state.deviceTargetPowerConfigs = {};
    await logSettingsError('Failed to load device control profiles', error, 'loadDeviceControlProfiles');
  }
};



export const applyLocalDeviceControlProfile = (
  deviceId: string,
  profile: SteppedLoadProfile | null,
): void => {
  const device = state.latestDevices.find((entry) => entry.id === deviceId);
  if (!device) return;
  if (!profile) {
    device.controlModel = supportsTemperatureDevice(device) ? 'temperature_target' : 'binary_power';
    delete device.steppedLoadProfile;
    delete device.desiredStepId;
    delete device.selectedStepId;
    delete device.planningPowerKw;
    return;
  }

  const selectedStepId = device.selectedStepId
    ?? device.desiredStepId
    ?? getSteppedLoadHighestStep(profile)?.id;
  device.controlModel = 'stepped_load';
  device.steppedLoadProfile = profile;
  device.selectedStepId = selectedStepId;
  device.planningPowerKw = resolveSteppedLoadPlanningPowerKw(profile, selectedStepId);
};

export const normalizeDeviceTargetPowerConfigs = (value: unknown): DeviceTargetPowerConfigs => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([deviceId, entry]) => {
      const config = normalizeTargetPowerConfig(entry);
      return config ? [[deviceId, config]] : [];
    }),
  );
};

export const normalizeTargetPowerConfig = (value: unknown): TargetPowerSteppedLoadConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const preset = record.preset === 'ev_charger_1_phase' || record.preset === 'ev_charger_3_phase'
    ? record.preset
    : undefined;
  const pickNumber = (key: string) => (
    typeof record[key] === 'number' && Number.isFinite(record[key])
      ? record[key] as number
      : undefined
  );
  const config: TargetPowerSteppedLoadConfig = {
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    ...(preset ? { preset } : {}),
    ...numberProp('min', pickNumber('min')),
    ...numberProp('max', pickNumber('max')),
    ...numberProp('step', pickNumber('step')),
    ...numberProp('excludeMin', pickNumber('excludeMin')),
    ...numberProp('excludeMax', pickNumber('excludeMax')),
  };
  if (Object.keys(config).length === 0) return null;
  if (config.enabled === false) return config;
  // Mirrors `normalizeTargetPowerSteppedLoadConfig` in the runtime: a preset
  // owns its own rungs, and any other range only counts when it yields a
  // ladder. A config that survives here is one the runtime will also accept.
  if (config.preset) return config;
  return resolveTargetPowerLadderIssue(config) === undefined ? config : null;
};

function numberProp<T extends 'min' | 'max' | 'step' | 'excludeMin' | 'excludeMax'>(
  key: T,
  value: number | undefined,
): Partial<Record<T, number>> {
  return value !== undefined ? { [key]: value } as Partial<Record<T, number>> : {};
}
