import { getSetting, getSettingFresh, setSetting } from './homey.ts';
import { state } from './state.ts';
import { createSerializedAsyncRunner } from './deviceDetail/settingsWrite.ts';
import {
  DEVICE_CONTROL_PROFILES,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  EV_BOOST_SETTINGS,
  EV_CAR_ASSOCIATIONS,
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_DEVICE_TARGETS,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  homeScopedSettingsKey,
} from '../../../contracts/src/settingsKeys.ts';
import { getHomeScope } from './homeScope.ts';
import { normalizeEvCarAssociations } from '../../../contracts/src/evCarAssociations.ts';
import type { EvCarAssociations } from '../../../contracts/src/types.ts';
import { assertWritableModeDeviceTargets, readModeDeviceTargetsSetting } from './modeCatalogMaps.ts';

/**
 * "Clear device data" on the Advanced page: which device ids the settings store
 * still references, which of those Homey no longer reports, and the writes that
 * remove one or many of them from every per-device settings map.
 *
 * Split out of `advanced.ts` so that file stays the page's DOM/handler
 * controller. The maps are enumerated explicitly rather than derived: a new
 * per-device setting must be added here deliberately, or clearing a device
 * would silently leave its config behind.
 */

export type PurgeableDeviceOption = {
  id: string;
  name: string;
};

const runSerializedPurge = createSerializedAsyncRunner();
let reconciliationRequiredForHomeIds: readonly string[] | null = null;

const readRecordSetting = <T>(value: unknown): Record<string, T> => {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, T>) };
  }
  throw new Error('Persisted device settings map is malformed');
};

const readReconciledRecordSetting = <T>(
  value: unknown,
  fallback: Record<string, T>,
): Record<string, T> => (
  value === null || value === undefined ? { ...fallback } : readRecordSetting<T>(value)
);

const getPurgeHomeIds = (): string[] => {
  const scope = getHomeScope();
  return [
    MAIN_HOME_ID,
    ...(scope.runtimeActive ? scope.areas.map((area) => area.homeId) : []),
  ];
};

const collectDeviceIdsFromSettings = (): Set<string> => {
  const simpleSettingIds = [
    ...Object.keys(state.controllableMap),
    ...Object.keys(state.managedMap),
    ...Object.keys(state.deviceControlProfiles),
    ...Object.keys(state.deviceTargetPowerConfigs),
    ...Object.keys(state.deviceExpectedPowerOverrides),
    ...Object.keys(state.shedBehaviors),
    ...Object.keys(state.temperatureBoostSettings),
    ...Object.keys(state.evBoostSettings),
    // Both sides of the association map: a charger that ONLY has ticked cars,
    // and a car that only appears inside some charger's list, are otherwise
    // invisible to cleanup discovery and can never be purged.
    ...Object.keys(state.evCarAssociations),
    ...Object.values(state.evCarAssociations).flatMap((entry) => entry.carIds),
    ...Object.keys(state.priceOptimizationSettings),
    ...Object.keys(state.temperatureControlDisabledMap),
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

const removeDeviceIdsFromRecord = <T>(
  map: Record<string, T>,
  deviceIds: Set<string>,
): Record<string, T> => Object.fromEntries(
  Object.entries(map).filter(([deviceId]) => !deviceIds.has(deviceId)),
);

/**
 * A purged device can appear on BOTH sides of this map: as the charger (the key)
 * and as a car inside another charger's list. Dropping only the key would leave
 * a deleted car ticked on every charger it was listed for, invisible in the UI
 * and permanently unmatchable. A charger left with no cars loses its entry —
 * empty means off.
 */
const purgeEvCarAssociations = (
  associations: EvCarAssociations,
  deviceIds: Set<string>,
): EvCarAssociations => Object.fromEntries(
  Object.entries(associations).flatMap(([chargerId, config]) => {
    if (deviceIds.has(chargerId)) return [];
    const carIds = config.carIds.filter((carId) => !deviceIds.has(carId));
    return carIds.length === 0 ? [] : [[chargerId, { carIds }]];
  }),
);

const buildPurgedState = (deviceIds: Set<string>) => ({
  controllableMap: removeDeviceIdsFromRecord(state.controllableMap, deviceIds),
  managedMap: removeDeviceIdsFromRecord(state.managedMap, deviceIds),
  deviceControlProfiles: removeDeviceIdsFromRecord(state.deviceControlProfiles, deviceIds),
  deviceTargetPowerConfigs: removeDeviceIdsFromRecord(state.deviceTargetPowerConfigs, deviceIds),
  deviceExpectedPowerOverrides: removeDeviceIdsFromRecord(state.deviceExpectedPowerOverrides, deviceIds),
  shedBehaviors: removeDeviceIdsFromRecord(state.shedBehaviors, deviceIds),
  temperatureBoostSettings: removeDeviceIdsFromRecord(state.temperatureBoostSettings, deviceIds),
  evBoostSettings: removeDeviceIdsFromRecord(state.evBoostSettings, deviceIds),
  evCarAssociations: purgeEvCarAssociations(state.evCarAssociations, deviceIds),
  priceOptimizationSettings: removeDeviceIdsFromRecord(state.priceOptimizationSettings, deviceIds),
  temperatureControlDisabledMap: removeDeviceIdsFromRecord(state.temperatureControlDisabledMap, deviceIds),
  capacityPriorities: removeDeviceIdsFromModeMap(state.capacityPriorities, deviceIds),
  modeTargets: removeDeviceIdsFromModeMap(state.modeTargets, deviceIds),
});

const applyPurgedState = (next: ReturnType<typeof buildPurgedState>): void => {
  state.controllableMap = next.controllableMap;
  state.managedMap = next.managedMap;
  state.deviceControlProfiles = next.deviceControlProfiles;
  state.deviceTargetPowerConfigs = next.deviceTargetPowerConfigs;
  state.deviceExpectedPowerOverrides = next.deviceExpectedPowerOverrides;
  state.shedBehaviors = next.shedBehaviors;
  state.temperatureBoostSettings = next.temperatureBoostSettings;
  state.evBoostSettings = next.evBoostSettings;
  state.evCarAssociations = next.evCarAssociations;
  state.priceOptimizationSettings = next.priceOptimizationSettings;
  state.temperatureControlDisabledMap = next.temperatureControlDisabledMap;
  state.capacityPriorities = next.capacityPriorities;
  state.modeTargets = next.modeTargets;
};

const purgeModeCatalogDeviceIds = async (
  deviceIds: Set<string>,
  homeIds: readonly string[],
): Promise<void> => {
  const catalogs = await Promise.all(homeIds.map(async (homeId) => {
    const prioritiesKey = homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId);
    const targetsKey = homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId);
    const [prioritiesRaw, targetsRaw] = await Promise.all([
      getSetting(prioritiesKey),
      getSetting(targetsKey),
    ]);
    // Through the key's owner, so a catalog the store already holds in a
    // malformed shape is repaired on the way IN rather than tripping the write
    // guard on the way out — which would abort the purge, possibly after its
    // sibling writes had already landed.
    const targets = readModeDeviceTargetsSetting(targetsRaw, false);
    if (
      !prioritiesRaw
      || typeof prioritiesRaw !== 'object'
      || Array.isArray(prioritiesRaw)
      || targets === null
    ) return null;
    return {
      prioritiesKey,
      targetsKey,
      priorities: prioritiesRaw as Record<string, Record<string, number>>,
      targets,
    };
  }));
  const writes = catalogs.flatMap((catalog) => (catalog === null ? [] : [
    setSetting(catalog.prioritiesKey, removeDeviceIdsFromModeMap(catalog.priorities, deviceIds)),
    setSetting(
      catalog.targetsKey,
      assertWritableModeDeviceTargets(removeDeviceIdsFromModeMap(catalog.targets, deviceIds)),
    ),
  ]));
  const results = await Promise.allSettled(writes);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
};

const reconcilePurgeState = async (homeIds: readonly string[]): Promise<void> => {
  const simpleBindings: Array<{
    key: string;
    fallback: Record<string, unknown>;
    apply: (value: unknown) => void;
  }> = [
    {
      key: 'controllable_devices', fallback: state.controllableMap,
      apply: (value) => { state.controllableMap = readRecordSetting(value); },
    },
    {
      key: 'managed_devices', fallback: state.managedMap,
      apply: (value) => { state.managedMap = readRecordSetting(value); },
    },
    {
      key: DEVICE_CONTROL_PROFILES, fallback: state.deviceControlProfiles,
      apply: (value) => { state.deviceControlProfiles = readRecordSetting(value); },
    },
    {
      key: DEVICE_TARGET_POWER_CONFIGS,
      fallback: state.deviceTargetPowerConfigs,
      apply: (value) => { state.deviceTargetPowerConfigs = readRecordSetting(value); },
    },
    {
      key: DEVICE_EXPECTED_POWER_OVERRIDES,
      fallback: state.deviceExpectedPowerOverrides,
      apply: (value) => { state.deviceExpectedPowerOverrides = readRecordSetting(value); },
    },
    {
      key: OVERSHOOT_BEHAVIORS, fallback: state.shedBehaviors,
      apply: (value) => { state.shedBehaviors = readRecordSetting(value); },
    },
    {
      key: TEMPERATURE_BOOST_SETTINGS,
      fallback: state.temperatureBoostSettings,
      apply: (value) => { state.temperatureBoostSettings = readRecordSetting(value); },
    },
    {
      key: EV_BOOST_SETTINGS, fallback: state.evBoostSettings,
      apply: (value) => { state.evBoostSettings = readRecordSetting(value); },
    },
    {
      key: EV_CAR_ASSOCIATIONS, fallback: state.evCarAssociations,
      apply: (value) => { state.evCarAssociations = normalizeEvCarAssociations(value); },
    },
    {
      key: 'price_optimization_settings',
      fallback: state.priceOptimizationSettings,
      apply: (value) => { state.priceOptimizationSettings = readRecordSetting(value); },
    },
    {
      key: TEMPERATURE_CONTROL_DISABLED_DEVICES,
      fallback: state.temperatureControlDisabledMap,
      apply: (value) => { state.temperatureControlDisabledMap = readRecordSetting(value); },
    },
  ];
  const [simpleReads, modeReads] = await Promise.all([
    Promise.all(simpleBindings.map(async (binding) => ({
      binding,
      value: readReconciledRecordSetting(await getSettingFresh(binding.key), binding.fallback),
    }))),
    Promise.all(homeIds.map(async (homeId) => ({
      homeId,
      priorities: readReconciledRecordSetting(
        await getSettingFresh(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId)),
        homeId === state.loadedModeHomeId ? state.capacityPriorities : {},
      ),
      targets: readReconciledRecordSetting(
        await getSettingFresh(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)),
        homeId === state.loadedModeHomeId ? state.modeTargets : {},
      ),
    }))),
  ]);
  simpleReads.forEach(({ binding, value }) => binding.apply(value));
  const loadedModes = modeReads.find(({ homeId }) => homeId === state.loadedModeHomeId);
  if (loadedModes) {
    state.capacityPriorities = loadedModes.priorities;
    state.modeTargets = loadedModes.targets;
  }
};

export const clearDeviceSettings = async (deviceId: string) => {
  await clearMultipleDeviceSettings([deviceId]);
};

const performClearMultipleDeviceSettings = async (deviceIds: string[]) => {
  if (reconciliationRequiredForHomeIds !== null) {
    const pendingHomeIds = reconciliationRequiredForHomeIds;
    await reconcilePurgeState(pendingHomeIds);
    reconciliationRequiredForHomeIds = null;
  }
  const ids = new Set(deviceIds);
  const homeIds = getPurgeHomeIds();
  const next = buildPurgedState(ids);

  const writeResults = await Promise.allSettled([
    setSetting('controllable_devices', next.controllableMap),
    setSetting('managed_devices', next.managedMap),
    setSetting(DEVICE_CONTROL_PROFILES, next.deviceControlProfiles),
    setSetting(DEVICE_TARGET_POWER_CONFIGS, next.deviceTargetPowerConfigs),
    setSetting(DEVICE_EXPECTED_POWER_OVERRIDES, next.deviceExpectedPowerOverrides),
    setSetting(OVERSHOOT_BEHAVIORS, next.shedBehaviors),
    setSetting(TEMPERATURE_BOOST_SETTINGS, next.temperatureBoostSettings),
    setSetting(EV_BOOST_SETTINGS, next.evBoostSettings),
    setSetting(EV_CAR_ASSOCIATIONS, next.evCarAssociations),
    setSetting('price_optimization_settings', next.priceOptimizationSettings),
    setSetting(TEMPERATURE_CONTROL_DISABLED_DEVICES, next.temperatureControlDisabledMap),
    purgeModeCatalogDeviceIds(ids, homeIds),
  ]);
  const failure = writeResults.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    reconciliationRequiredForHomeIds = homeIds;
    await reconcilePurgeState(homeIds);
    reconciliationRequiredForHomeIds = null;
    throw failure.reason;
  }

  applyPurgedState(next);
};

export const clearMultipleDeviceSettings = (deviceIds: string[]) => (
  runSerializedPurge(() => performClearMultipleDeviceSettings(deviceIds))
);
