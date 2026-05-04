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
  TargetDeviceSnapshot,
} from '../../../contracts/src/types.ts';
import { DEVICE_CONTROL_PROFILES, DEVICE_TARGET_POWER_CONFIGS } from '../../../contracts/src/settingsKeys.ts';
import { getSetting, setSetting } from './homey.ts';
import { state } from './state.ts';
import { supportsTemperatureDevice } from './deviceUtils.ts';
import { logSettingsError } from './logging.ts';

const DEFAULT_MAX_PLANNING_POWER_W = 1500;
const roundPowerW = (value: number): number => Math.max(0, Math.round(value / 50) * 50);

const resolveEstimatedMaxPlanningPowerW = (device: TargetDeviceSnapshot): number => {
  const knownKw = [
    device.planningPowerKw,
    device.expectedPowerKw,
    device.loadKw,
    device.measuredPowerKw,
    device.powerKw,
  ].find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return roundPowerW((knownKw ?? (DEFAULT_MAX_PLANNING_POWER_W / 1000)) * 1000) || DEFAULT_MAX_PLANNING_POWER_W;
};

export const createDefaultSteppedLoadProfile = (device: TargetDeviceSnapshot): SteppedLoadProfile => {
  if (device.suggestedSteppedLoadProfile?.model === 'stepped_load') {
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
  return {
    model: 'stepped_load',
    steps,
  };
};

export const getStoredDeviceControlProfile = (deviceId: string) => state.deviceControlProfiles[deviceId] ?? null;
export const getStoredTargetPowerConfig = (deviceId: string) => state.deviceTargetPowerConfigs[deviceId] ?? null;

export const isNativeSteppedLoadProfileActive = (device?: TargetDeviceSnapshot | null): boolean => (
  device?.controlAdapter?.kind === 'capability_adapter'
  && device.controlAdapter.activationEnabled === true
  && device.suggestedSteppedLoadProfile?.model === 'stepped_load'
);

const hasSteppedLoadProfileState = (device: TargetDeviceSnapshot): boolean => (
  device.steppedLoadProfile?.model === 'stepped_load'
  || device.suggestedSteppedLoadProfile?.model === 'stepped_load'
  || getStoredDeviceControlProfile(device.id)?.model === 'stepped_load'
);

const hasEnabledEvTargetPowerPreset = (device: TargetDeviceSnapshot): boolean => {
  const targetPowerConfig = getStoredTargetPowerConfig(device.id) ?? device.targetPowerConfig;
  return targetPowerConfig?.enabled !== false
    && (targetPowerConfig?.preset === 'ev_charger_1_phase' || targetPowerConfig?.preset === 'ev_charger_3_phase');
};

export const hasSteppedLoadSupport = (device?: TargetDeviceSnapshot | null): boolean => {
  if (!device) return false;
  if (isNativeSteppedLoadProfileActive(device)) return true;
  if (hasSteppedLoadProfileState(device)) return true;
  if (hasEnabledEvTargetPowerPreset(device)) return true;
  return false;
};

export const getEffectiveControlModel = (device: TargetDeviceSnapshot): DeviceControlModel => {
  if (isNativeSteppedLoadProfileActive(device)) return 'stepped_load';
  if (device.controlModel) return device.controlModel;
  const storedProfile = getStoredDeviceControlProfile(device.id);
  if (storedProfile?.model === 'stepped_load') return 'stepped_load';
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

export const saveDeviceControlProfiles = async (): Promise<void> => {
  await setSetting(DEVICE_CONTROL_PROFILES, state.deviceControlProfiles);
};

export const saveDeviceTargetPowerConfigs = async (): Promise<void> => {
  await setSetting(DEVICE_TARGET_POWER_CONFIGS, state.deviceTargetPowerConfigs);
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
    delete device.actualStepId;
    delete device.assumedStepId;
    delete device.selectedStepId;
    delete device.actualStepSource;
    delete device.planningPowerKw;
    if ((device.expectedPowerSource as string) === 'step-planning') {
      delete device.expectedPowerSource;
    }
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
  if (config.preset || (config.max !== undefined && config.step !== undefined)) return config;
  return null;
};

function numberProp<T extends 'min' | 'max' | 'step' | 'excludeMin' | 'excludeMax'>(
  key: T,
  value: number | undefined,
): Partial<Record<T, number>> {
  return value !== undefined ? { [key]: value } as Partial<Record<T, number>> : {};
}
