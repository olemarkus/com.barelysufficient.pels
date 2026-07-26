import { setSetting } from './homey.ts';
import { state } from './state.ts';
import {
  DEVICE_CONTROL_PROFILES,
  DEVICE_TARGET_POWER_CONFIGS,
  EV_BOOST_SETTINGS,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
} from '../../../contracts/src/settingsKeys.ts';

/**
 * "Clear device data" on the Advanced page: which device ids the settings store
 * still references, which of those Homey no longer reports, and the writes that
 * remove one or many of them from every per-device settings map.
 *
 * Split out of `advanced.ts` so that file stays the page's DOM/handler
 * controller. The ten maps are enumerated explicitly rather than derived: a new
 * per-device setting must be added here deliberately, or clearing a device
 * would silently leave its config behind.
 */

export type PurgeableDeviceOption = {
  id: string;
  name: string;
};

const collectDeviceIdsFromSettings = (): Set<string> => {
  const simpleSettingIds = [
    ...Object.keys(state.controllableMap),
    ...Object.keys(state.managedMap),
    ...Object.keys(state.deviceControlProfiles),
    ...Object.keys(state.deviceTargetPowerConfigs),
    ...Object.keys(state.shedBehaviors),
    ...Object.keys(state.temperatureBoostSettings),
    ...Object.keys(state.evBoostSettings),
    ...Object.keys(state.priceOptimizationSettings),
  ];

  const modeMapIds = (modeMap: Record<string, Record<string, number>>) => (
    Object.values(modeMap || {}).flatMap((devices) => Object.keys(devices || {}))
  );

  return new Set([
    ...simpleSettingIds,
    ...modeMapIds(state.capacityPriorities),
    ...modeMapIds(state.modeTargets),
  ]);
};

export const resolveDeviceOptionsFromSettings = (): PurgeableDeviceOption[] => {
  const nameById = new Map<string, string>();
  state.latestDevices.forEach((device) => {
    nameById.set(device.id, device.name);
  });
  return Array.from(collectDeviceIdsFromSettings()).map((id) => ({
    id,
    name: nameById.get(id) ?? `Unknown device (${id})`,
  }));
};

export const resolveUnknownDeviceIdsFromSettings = (): string[] => {
  const knownIds = new Set(state.latestDevices.map((device) => device.id));
  return Array.from(collectDeviceIdsFromSettings()).filter((id) => !knownIds.has(id));
};

const removeDeviceFromModeMap = (
  map: Record<string, Record<string, number>>,
  deviceId: string,
): Record<string, Record<string, number>> => {
  const updated: Record<string, Record<string, number>> = {};
  Object.entries(map).forEach(([mode, devices]) => {
    if (!devices || devices[deviceId] === undefined) {
      updated[mode] = devices;
      return;
    }
    const { [deviceId]: _removed, ...rest } = devices;
    updated[mode] = rest;
  });
  return updated;
};

const removeDeviceIdsFromModeMap = (
  map: Record<string, Record<string, number>>,
  deviceIds: Set<string>,
): Record<string, Record<string, number>> => {
  const updated: Record<string, Record<string, number>> = {};
  Object.entries(map).forEach(([mode, devices]) => {
    if (!devices) {
      updated[mode] = devices;
      return;
    }
    const filtered = Object.fromEntries(
      Object.entries(devices).filter(([deviceId]) => !deviceIds.has(deviceId)),
    );
    updated[mode] = filtered;
  });
  return updated;
};

export const clearDeviceSettings = async (deviceId: string) => {
  const nextControllableMap = { ...state.controllableMap };
  const nextManagedMap = { ...state.managedMap };
  const nextDeviceControlProfiles = { ...state.deviceControlProfiles };
  const nextDeviceTargetPowerConfigs = { ...state.deviceTargetPowerConfigs };
  const nextShedBehaviors = { ...state.shedBehaviors };
  const nextTemperatureBoost = { ...state.temperatureBoostSettings };
  const nextEvBoost = { ...state.evBoostSettings };
  const nextPriceOptimization = { ...state.priceOptimizationSettings };
  delete nextControllableMap[deviceId];
  delete nextManagedMap[deviceId];
  delete nextDeviceControlProfiles[deviceId];
  delete nextDeviceTargetPowerConfigs[deviceId];
  delete nextShedBehaviors[deviceId];
  delete nextTemperatureBoost[deviceId];
  delete nextEvBoost[deviceId];
  delete nextPriceOptimization[deviceId];
  const nextCapacityPriorities = removeDeviceFromModeMap(state.capacityPriorities, deviceId);
  const nextModeTargets = removeDeviceFromModeMap(state.modeTargets, deviceId);

  await Promise.all([
    setSetting('controllable_devices', nextControllableMap),
    setSetting('managed_devices', nextManagedMap),
    setSetting(DEVICE_CONTROL_PROFILES, nextDeviceControlProfiles),
    setSetting(DEVICE_TARGET_POWER_CONFIGS, nextDeviceTargetPowerConfigs),
    setSetting(OVERSHOOT_BEHAVIORS, nextShedBehaviors),
    setSetting(TEMPERATURE_BOOST_SETTINGS, nextTemperatureBoost),
    setSetting(EV_BOOST_SETTINGS, nextEvBoost),
    setSetting('price_optimization_settings', nextPriceOptimization),
    setSetting('capacity_priorities', nextCapacityPriorities),
    setSetting('mode_device_targets', nextModeTargets),
  ]);

  state.controllableMap = nextControllableMap;
  state.managedMap = nextManagedMap;
  state.deviceControlProfiles = nextDeviceControlProfiles;
  state.deviceTargetPowerConfigs = nextDeviceTargetPowerConfigs;
  state.shedBehaviors = nextShedBehaviors;
  state.temperatureBoostSettings = nextTemperatureBoost;
  state.evBoostSettings = nextEvBoost;
  state.priceOptimizationSettings = nextPriceOptimization;
  state.capacityPriorities = nextCapacityPriorities;
  state.modeTargets = nextModeTargets;
};

export const clearMultipleDeviceSettings = async (deviceIds: string[]) => {
  const ids = new Set(deviceIds);
  const nextControllableMap = { ...state.controllableMap };
  const nextManagedMap = { ...state.managedMap };
  const nextDeviceControlProfiles = { ...state.deviceControlProfiles };
  const nextDeviceTargetPowerConfigs = { ...state.deviceTargetPowerConfigs };
  const nextShedBehaviors = { ...state.shedBehaviors };
  const nextTemperatureBoost = { ...state.temperatureBoostSettings };
  const nextEvBoost = { ...state.evBoostSettings };
  const nextPriceOptimization = { ...state.priceOptimizationSettings };
  deviceIds.forEach((deviceId) => {
    delete nextControllableMap[deviceId];
    delete nextManagedMap[deviceId];
    delete nextDeviceControlProfiles[deviceId];
    delete nextDeviceTargetPowerConfigs[deviceId];
    delete nextShedBehaviors[deviceId];
    delete nextTemperatureBoost[deviceId];
    delete nextEvBoost[deviceId];
    delete nextPriceOptimization[deviceId];
  });
  const nextCapacityPriorities = removeDeviceIdsFromModeMap(state.capacityPriorities, ids);
  const nextModeTargets = removeDeviceIdsFromModeMap(state.modeTargets, ids);

  await Promise.all([
    setSetting('controllable_devices', nextControllableMap),
    setSetting('managed_devices', nextManagedMap),
    setSetting(DEVICE_CONTROL_PROFILES, nextDeviceControlProfiles),
    setSetting(DEVICE_TARGET_POWER_CONFIGS, nextDeviceTargetPowerConfigs),
    setSetting(OVERSHOOT_BEHAVIORS, nextShedBehaviors),
    setSetting(TEMPERATURE_BOOST_SETTINGS, nextTemperatureBoost),
    setSetting(EV_BOOST_SETTINGS, nextEvBoost),
    setSetting('price_optimization_settings', nextPriceOptimization),
    setSetting('capacity_priorities', nextCapacityPriorities),
    setSetting('mode_device_targets', nextModeTargets),
  ]);

  state.controllableMap = nextControllableMap;
  state.managedMap = nextManagedMap;
  state.deviceControlProfiles = nextDeviceControlProfiles;
  state.deviceTargetPowerConfigs = nextDeviceTargetPowerConfigs;
  state.shedBehaviors = nextShedBehaviors;
  state.temperatureBoostSettings = nextTemperatureBoost;
  state.evBoostSettings = nextEvBoost;
  state.priceOptimizationSettings = nextPriceOptimization;
  state.capacityPriorities = nextCapacityPriorities;
  state.modeTargets = nextModeTargets;
};
