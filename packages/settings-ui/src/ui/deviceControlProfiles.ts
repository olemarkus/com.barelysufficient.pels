import {
  getSteppedLoadHighestStep,
  normalizeDeviceControlProfiles,
  resolveSteppedLoadPlanningPowerKw,
} from '../../../contracts/src/deviceControlProfiles';
import type {
  DeviceControlModel,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../../contracts/src/types';
import { DEVICE_CONTROL_PROFILES } from '../../../contracts/src/settingsKeys';
import { getSetting, setSetting } from './homey';
import { state } from './state';
import { supportsTemperatureDevice } from './deviceUtils';
import { logSettingsError } from './logging';

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

export const getEffectiveControlModel = (device: TargetDeviceSnapshot): DeviceControlModel => {
  if (device.controlModel) return device.controlModel;
  const storedProfile = getStoredDeviceControlProfile(device.id);
  if (storedProfile?.model === 'stepped_load') return 'stepped_load';
  return supportsTemperatureDevice(device) ? 'temperature_target' : 'binary_power';
};

export const loadDeviceControlProfiles = async (): Promise<void> => {
  try {
    state.deviceControlProfiles = normalizeDeviceControlProfiles(await getSetting(DEVICE_CONTROL_PROFILES)) ?? {};
  } catch (error) {
    state.deviceControlProfiles = {};
    await logSettingsError('Failed to load device control profiles', error, 'loadDeviceControlProfiles');
  }
};

export const saveDeviceControlProfiles = async (): Promise<void> => {
  await setSetting(DEVICE_CONTROL_PROFILES, state.deviceControlProfiles);
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
