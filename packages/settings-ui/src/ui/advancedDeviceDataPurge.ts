import { readModePriorityCatalog } from '../../../shared-domain/src/settings/modePriorities.ts';
import {
  readTemperatureControlModes, temperatureControlDisabledDevices,
} from '../../../shared-domain/src/settings/temperatureControl.ts';
import { callApi, getSetting, getSettingFresh, setSetting } from './homey.ts';
import { state } from './state.ts';
import { hasLoadedDeferredObjectiveSettings, loadDeferredObjectiveSettings } from './deferredObjectiveSettings.ts';
import { createSerializedAsyncRunner } from './deviceDetail/settingsWrite.ts';
import {
  DEVICE_CONTROL_PROFILES,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  EV_BOOST_SETTINGS,
  EV_CHARGE_TARGET_SETTINGS,
  EV_CAR_ASSOCIATIONS,
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_DEVICE_TARGETS,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  TEMPERATURE_CONTROL_MODES,
  homeScopedSettingsKey,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  PRICE_OPTIMIZATION_SETTINGS,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { SETTINGS_UI_SMART_TASK_CANCEL_PATH } from '../../../contracts/src/settingsUiApi.ts';
import type {
  SettingsUiSmartTaskCancelRequest,
  SettingsUiSmartTaskCancelResponse,
} from '../../../contracts/src/smartTaskEdit.ts';
import { getHomeScope } from './homeScope.ts';
import { normalizeEvCarAssociations } from '../../../shared-domain/src/settings/evCarAssociations.ts';
import type { EvCarAssociations } from '../../../contracts/src/types.ts';
import { assertWritableModeDeviceTargets, readModeDeviceTargetsSetting } from './modeCatalogMaps.ts';
import { isShedBehaviorsSetting, readShedBehaviors } from '../../../shared-domain/src/settings/shedBehaviors.ts';
import { classifyPriceOptimizationConfigMap } from './priceOptimizationConfig.ts';
import { readStrictBooleanSettingMap } from './modeSettingsRead.ts';

/**
 * "Clear device data" on the Advanced page: which device ids the settings store
 * still references, which of those Homey no longer reports, and the writes that
 * remove one or many of them from every per-device settings map.
 *
 * Split out of `advanced.ts` so that file stays the page's DOM/handler
 * controller. The maps are enumerated explicitly rather than derived: a new
 * per-device setting must be added here deliberately, or clearing a device
 * would silently leave its config behind.
 *
 * A device's smart task is not a settings map the UI may write: the runtime owns
 * `deferred_objective.<id>` and its forget side effects. The purge clears it
 * through the same cancel endpoint the Smart tasks page uses.
 */

export type PurgeableDeviceOption = {
  id: string;
  name: string;
};

const runSerializedPurge = createSerializedAsyncRunner();

const readRecordSetting = <T>(value: unknown): Record<string, T> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, T>) } : null
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
    ...Object.keys(state.evChargeTargetSettings),
    // Both sides of the association map: a charger that ONLY has ticked cars,
    // and a car that only appears inside some charger's list, are otherwise
    // invisible to cleanup discovery and can never be purged.
    ...Object.keys(state.evCarAssociations),
    ...Object.values(state.evCarAssociations).flatMap((entry) => entry.carIds),
    ...Object.keys(state.priceOptimizationSettings),
    ...Object.keys(state.temperatureControlDisabledMap),
    ...Object.keys(state.temperatureControlModes),
    ...Object.keys(state.respectExternalOffMap),
    // A task whose device has no other setting left is still the device's data.
    ...Object.keys(state.deferredObjectiveSettings.objectivesByDeviceId),
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

/**
 * One per-device settings map the purge edits. The purge works on the STORED
 * map, read fresh through its key owner's reader, never on the page's copy: a
 * copy whose boot read failed or has not landed yet is an empty default, and
 * writing it would erase every other device's entry. A stored value the purge
 * cannot use (it reads back absent, or its owner rejects it and keeps its own
 * last-good copy) is left alone. That is only a clean purge when the page copy
 * has none of the purged ids either: a device the page knows is there and the
 * read could not find fails the purge rather than reading as cleared.
 */
type PurgedMap = {
  purge: (deviceIds: Set<string>) => Promise<void>;
  /** Re-reads the page copy from the store, after a purge that failed part-way. */
  refresh: () => Promise<void>;
};

const purgedMap = <T>(
  key: string,
  read: (value: unknown) => T | null,
  pageCopy: () => T,
  apply: (map: T) => void,
  remove: (map: T, deviceIds: Set<string>) => T,
): PurgedMap => {
  const readStored = async (): Promise<T | null> => {
    const value = await getSettingFresh(key);
    return value === null || value === undefined ? null : read(value);
  };
  return {
    purge: async (deviceIds) => {
      const stored = await readStored();
      if (stored === null) {
        const copy = pageCopy();
        if (JSON.stringify(remove(copy, deviceIds)) === JSON.stringify(copy)) return;
        throw new Error(`Could not read ${key} to clear the device from it. Try again.`);
      }
      const next = remove(stored, deviceIds);
      await setSetting(key, next);
      apply(next);
    },
    refresh: async () => {
      const stored = await readStored();
      if (stored !== null) apply(stored);
    },
  };
};

const purgedRecord = <T>(
  key: string,
  pageCopy: () => Record<string, T>,
  apply: (map: Record<string, T>) => void,
): PurgedMap => purgedMap(key, readRecordSetting<T>, pageCopy, apply, removeDeviceIdsFromRecord);

const PURGED_MAPS: readonly PurgedMap[] = [
  purgedRecord(
    CONTROLLABLE_DEVICES,
    () => state.controllableMap,
    (map) => { state.controllableMap = map; },
  ),
  purgedRecord(MANAGED_DEVICES, () => state.managedMap, (map) => { state.managedMap = map; }),
  purgedRecord(
    DEVICE_CONTROL_PROFILES,
    () => state.deviceControlProfiles,
    (map) => { state.deviceControlProfiles = map; },
  ),
  purgedRecord(
    DEVICE_TARGET_POWER_CONFIGS,
    () => state.deviceTargetPowerConfigs,
    (map) => { state.deviceTargetPowerConfigs = map; },
  ),
  purgedRecord(
    DEVICE_EXPECTED_POWER_OVERRIDES,
    () => state.deviceExpectedPowerOverrides,
    (map) => { state.deviceExpectedPowerOverrides = map; },
  ),
  purgedMap(
    OVERSHOOT_BEHAVIORS,
    (value) => (isShedBehaviorsSetting(value) ? readShedBehaviors(value) : null),
    () => state.shedBehaviors,
    (map) => { state.shedBehaviors = map; },
    removeDeviceIdsFromRecord,
  ),
  purgedRecord(
    TEMPERATURE_BOOST_SETTINGS,
    () => state.temperatureBoostSettings,
    (map) => { state.temperatureBoostSettings = map; },
  ),
  purgedRecord(EV_BOOST_SETTINGS, () => state.evBoostSettings, (map) => { state.evBoostSettings = map; }),
  purgedRecord(
    EV_CHARGE_TARGET_SETTINGS,
    () => state.evChargeTargetSettings,
    (map) => { state.evChargeTargetSettings = map; },
  ),
  purgedMap(
    EV_CAR_ASSOCIATIONS,
    normalizeEvCarAssociations,
    () => state.evCarAssociations,
    (map) => { state.evCarAssociations = map; },
    purgeEvCarAssociations,
  ),
  purgedMap(
    PRICE_OPTIMIZATION_SETTINGS,
    (value) => {
      const read = classifyPriceOptimizationConfigMap(value);
      return read.state === 'resolved' ? read.settings : null;
    },
    () => state.priceOptimizationSettings,
    (map) => { state.priceOptimizationSettings = map; },
    removeDeviceIdsFromRecord,
  ),
  purgedMap(
    TEMPERATURE_CONTROL_MODES,
    readTemperatureControlModes,
    () => state.temperatureControlModes,
    (map) => { state.temperatureControlModes = map; },
    removeDeviceIdsFromRecord,
  ),
  // The stored key is the legacy opt-out; the page's map is derived from it and
  // the control modes, as the boot read derives it (`applyTemperatureControlSettings`).
  purgedMap(
    TEMPERATURE_CONTROL_DISABLED_DEVICES,
    readStrictBooleanSettingMap,
    // An explicit mode overrides the legacy entry, so only the rest is the legacy key's.
    () => Object.fromEntries(Object.entries(state.temperatureControlDisabledMap)
      .filter(([deviceId]) => !Object.hasOwn(state.temperatureControlModes, deviceId))),
    (legacy) => {
      state.temperatureControlDisabledMap = temperatureControlDisabledDevices(state.temperatureControlModes, legacy);
    },
    removeDeviceIdsFromRecord,
  ),
  // The runtime releases a persisted hold for every device that leaves this map,
  // so dropping the opt-in also drops the hold it armed. Strict, like the
  // runtime's reader: on a malformed value the runtime keeps its own last-good
  // map, so the purge must not write one that drops other devices' opt-ins.
  purgedMap(
    RESPECT_EXTERNAL_OFF_DEVICES,
    readStrictBooleanSettingMap,
    () => state.respectExternalOffMap,
    (map) => { state.respectExternalOffMap = map; },
    removeDeviceIdsFromRecord,
  ),
];

/**
 * Clears each purged device's smart task through the runtime's cancel op, so the
 * task's history is finalized and its live status forgotten exactly as on the
 * Smart tasks page. Only devices the task map lists are asked (loaded first if
 * the boot read failed): a device with no task has nothing to cancel. `task_not_found` means the task already
 * ended, which is the outcome the purge wants.
 */
const cancelSmartTasks = async (deviceIds: Set<string>): Promise<void> => {
  // An empty map also reads as "not loaded" (a failed boot read); never take it
  // for "no tasks" before deciding there is nothing to cancel.
  if (!hasLoadedDeferredObjectiveSettings()) await loadDeferredObjectiveSettings();
  const withTask = [...deviceIds].filter((deviceId) => (
    state.deferredObjectiveSettings.objectivesByDeviceId[deviceId] !== undefined
  ));
  const results = await Promise.allSettled(withTask.map(async (deviceId) => {
    const body: SettingsUiSmartTaskCancelRequest = { deviceId };
    const response = await callApi<SettingsUiSmartTaskCancelResponse>(
      'POST',
      SETTINGS_UI_SMART_TASK_CANCEL_PATH,
      body,
    );
    if (!response.ok && response.reason !== 'task_not_found') {
      throw new Error(`Could not clear the smart task for ${deviceId} (${response.reason})`);
    }
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
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
    const priorities = readModePriorityCatalog(prioritiesRaw);
    if (priorities === null || targets === null) return null;
    return {
      prioritiesKey,
      targetsKey,
      priorities: priorities.resolve([], Object.keys(targets)),
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
  const [, modeReads] = await Promise.all([
    Promise.all(PURGED_MAPS.map((map) => map.refresh())),
    Promise.all(homeIds.map(async (homeId) => ({
      homeId,
      priorities: readModePriorityCatalog(await getSettingFresh(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId))),
      targets: readModeDeviceTargetsSetting(
        await getSettingFresh(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)),
        false,
      ),
    }))),
  ]);
  const loadedModes = modeReads.find(({ homeId }) => homeId === state.loadedModeHomeId);
  if (loadedModes) {
    if (loadedModes.priorities !== null) state.modePriorityCatalog = loadedModes.priorities;
    if (loadedModes.targets !== null) state.modeTargets = loadedModes.targets;
  }
};

export const clearDeviceSettings = async (deviceId: string) => {
  await clearMultipleDeviceSettings([deviceId]);
};

const performClearMultipleDeviceSettings = async (deviceIds: string[]) => {
  const ids = new Set(deviceIds);
  const homeIds = getPurgeHomeIds();

  const writeResults = await Promise.allSettled([
    ...PURGED_MAPS.map((map) => map.purge(ids)),
    purgeModeCatalogDeviceIds(ids, homeIds),
    cancelSmartTasks(ids),
  ]);
  const failure = writeResults.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    await reconcilePurgeState(homeIds);
    throw failure.reason;
  }

  // Derived from the control modes too, which may have settled after the legacy key.
  state.temperatureControlDisabledMap = removeDeviceIdsFromRecord(state.temperatureControlDisabledMap, ids);
  state.capacityPriorities = removeDeviceIdsFromModeMap(state.capacityPriorities, ids);
  state.modeTargets = removeDeviceIdsFromModeMap(state.modeTargets, ids);
};

export const clearMultipleDeviceSettings = (deviceIds: string[]) => (
  runSerializedPurge(() => performClearMultipleDeviceSettings(deviceIds))
);
