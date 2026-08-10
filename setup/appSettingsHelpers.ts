import type Homey from 'homey';
import type { ShedBehavior } from '../lib/plan/planTypes';
import type {
  DeviceControlProfiles,
  EvBoostSettings,
  EvCarAssociations,
  TargetPowerReachabilityState,
  TemperatureBoostSettings,
} from '../packages/contracts/src/types';
import {
  getAllModes as getAllModesHelper,
  normalizeShedBehaviors as normalizeShedBehaviorsHelper,
  resolveModeName as resolveModeNameHelper,
} from '../lib/utils/capacityHelpers';
import { createSettingsHandler } from '../lib/utils/settingsHandlers';
import {
  stopFlowPowerSampleFreshnessClock,
  syncFlowPowerSampleFreshnessClock,
} from './flowPowerSampleFreshnessClock';
import { createCapacitySettingsStore } from './capacitySettingsStoreAdapter';
import {
  isDeviceControlProfiles,
  isBooleanMap,
  isCommunicationModelMap,
  isModeDeviceTargets,
  isPrioritySettings,
  isStringMap,
  normalizeEvBoostSettings,
  normalizeTemperatureBoostSettings,
} from '../lib/utils/appTypeGuards';
import { normalizeEvCarAssociations } from '../lib/utils/evCarAssociations';
import {
  normalizeCompleteTargetPowerReachabilityByDevice,
  normalizeDeviceTargetPowerConfigs,
} from '../lib/utils/targetPowerConfig';
import {
  type DeviceTargetPowerConfigsWithReachability,
  resolveValidTargetPowerReachability,
} from '../lib/device/targetPowerReachability';
import { normalizeModePriorities } from '../packages/shared-domain/src/modePriorities';
import {
  BUDGET_EXEMPT_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_COMMUNICATION_MODELS,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_TARGET_POWER_REACHABILITY,
  EV_BOOST_SETTINGS,
  EV_CAR_ASSOCIATIONS,
  NATIVE_EV_WIRING_DEVICES,
  CONTROLLABLE_DEVICES,
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MANAGED_DEVICES,
  MODE_ALIASES,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  parseHomeScopedSettingsKey,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  TEMPERATURE_BOOST_SETTINGS,
} from '../lib/utils/settingsKeys';
import type { PriceCoordinator } from '../lib/price/priceCoordinator';
import type { SettingsHandler } from '../lib/utils/settingsHandlers';
import type { AppContext } from '../lib/app/appContext';
import { resolveTemperatureControlDisabled } from './appDeviceControlHelpers';

export type CapacitySettingsSnapshot = {
  capacitySettings: { limitKw: number; marginKw: number };
  modeAliases: Record<string, string>;
  operatingMode: string;
  capacityPriorities: Record<string, Record<string, number>>;
  modeDeviceTargets: Record<string, Record<string, number>>;
  capacityDryRun: boolean;
  controllableDevices: Record<string, boolean>;
  managedDevices: Record<string, boolean>;
  budgetExemptDevices: Record<string, boolean>;
  temperatureControlDisabledDevices: Record<string, boolean>;
  temperatureControlPolicyState: 'unavailable' | 'resolved';
  temperatureBoostSettings: TemperatureBoostSettings;
  evBoostSettings: EvBoostSettings;
  evCarAssociations: EvCarAssociations;
  nativeEvWiringDevices: Record<string, boolean>;
  deviceDriverOverrides: Record<string, string>;
  deviceControlProfiles: DeviceControlProfiles;
  deviceTargetPowerConfigs: DeviceTargetPowerConfigsWithReachability;
  deviceCommunicationModels: Record<string, 'local' | 'cloud'>;
  shedBehaviors: Record<string, ShedBehavior>;
};

/**
 * The two reads this classification needs, typed as the untrusted boundary they
 * are. `ManagerSettings` is assignable; so is a plain object double, so specs
 * pin the branches without an `as unknown as` cast that would let a
 * structurally wrong double throw into the `catch` and assert nothing.
 */
type TemperatureControlSettingsPort = {
  get(key: string): unknown;
  getKeys(): unknown;
};

/**
 * Resolve the persisted temperature-command policy at the settings boundary.
 * A malformed transient read retains the last-good in-memory policy.
 *
 * `ManagerSettings.get` answers an unset key with `null`, not `undefined`, so
 * absence must be classified on BOTH — gating only on `undefined` left the
 * key-list cross-check unreachable on a real Homey and pinned the policy at
 * `unavailable`, which fails closed over every temperature device (an install
 * that never touched the toggle lost all setpoint control). The cross-check
 * still separates a genuinely absent key from a transient miss: a listed key
 * that reads empty, an empty key list, a malformed value, or a throw all stay
 * `unavailable`. `undefined` stays in the disjunction for object doubles and
 * any runtime that answers that way; the SDK itself only produces `null`.
 */
export function readTemperatureControlDisabledDevicesSetting(params: {
  settings: TemperatureControlSettingsPort;
  current: {
    devices: Record<string, boolean>;
    state: 'unavailable' | 'resolved';
  };
}): {
  devices: Record<string, boolean>;
  state: 'unavailable' | 'resolved';
} {
  try {
    const raw = params.settings.get(TEMPERATURE_CONTROL_DISABLED_DEVICES);
    if (isBooleanMap(raw)) return { devices: raw, state: 'resolved' };
    if (raw === undefined || raw === null) {
      const keys = params.settings.getKeys();
      if (
        Array.isArray(keys)
        && keys.length > 0
        && keys.every((key): key is string => typeof key === 'string')
        && !keys.includes(TEMPERATURE_CONTROL_DISABLED_DEVICES)
      ) {
        return { devices: {}, state: 'resolved' };
      }
    }
  } catch {
    // The semantic unavailable state below retains a previously resolved value.
  }
  return params.current.state === 'resolved'
    ? params.current
    : { devices: {}, state: 'unavailable' };
}

export function loadTemperatureControlPolicySettingsForApp(ctx: AppContext): void {
  const policy = readTemperatureControlDisabledDevicesSetting({
    settings: ctx.homey.settings,
    current: {
      devices: ctx.temperatureControlDisabledDevices,
      state: ctx.temperatureControlPolicyState,
    },
  });
  // Wiring owns the mutable AppContext cache; consumers only read its resolved state.
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.temperatureControlDisabledDevices = policy.devices;
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.temperatureControlPolicyState = policy.state;
}

export function isTemperatureControlDisabledForApp(ctx: AppContext, deviceId: string): boolean {
  if (ctx.temperatureControlPolicyState === 'unavailable') {
    ctx.loadTemperatureControlPolicySettings();
  }
  return resolveTemperatureControlDisabled({
    policyState: ctx.temperatureControlPolicyState,
    disabledDevices: ctx.temperatureControlDisabledDevices,
    deviceId,
    device: ctx.deviceManager?.getSnapshotByDeviceId(deviceId),
  });
}

export function buildCapacitySettingsSnapshot(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): CapacitySettingsSnapshot {
  const { settings, current } = params;
  const capacityScalars = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({
    limitKw: current.capacitySettings.limitKw,
    marginKw: current.capacitySettings.marginKw,
    dryRun: current.capacityDryRun,
  })).read();
  const modeRaw = settings.get(OPERATING_MODE_SETTING) as unknown;
  const modeAliases = settings.get('mode_aliases') as unknown;
  const priorities = settings.get('capacity_priorities') as unknown;
  const modeTargets = settings.get('mode_device_targets') as unknown;
  const deviceFlags = readDeviceFlagSettings({ settings, current });
  const deviceSettings = readDeviceControlSettings({ settings, current });
  const deviceOverrides = readDeviceOverrideSettings({ settings, current });
  const nativeEvSettings = readNativeEvSettings({ settings, current });
  const rawShedBehaviors = settings.get(OVERSHOOT_BEHAVIORS) as unknown;
  const rawTemperatureBoostSettings = settings.get(TEMPERATURE_BOOST_SETTINGS) as unknown;
  const rawEvBoostSettings = settings.get(EV_BOOST_SETTINGS) as unknown;
  const rawEvCarAssociations = settings.get(EV_CAR_ASSOCIATIONS) as unknown;

  const nextCapacity = {
    limitKw: capacityScalars.limitKw,
    marginKw: capacityScalars.marginKw,
  };

  const nextAliases = isStringMap(modeAliases)
    ? Object.fromEntries(
      Object.entries(modeAliases).map(([k, v]) => [k.toLowerCase(), v]),
    )
    : current.modeAliases;

  // Resolve aliases against the mode records that actually survived a rename.
  // Do this before the active-mode read so a retained chain can skip a removed
  // intermediate name, while a name swap stops at its still-configured target.
  const nextPriorities = normalizeModePriorities(
    isPrioritySettings(priorities) ? priorities : current.capacityPriorities,
  );
  const nextTargets = isModeDeviceTargets(modeTargets) ? modeTargets : current.modeDeviceTargets;
  const nextMode = (typeof modeRaw === 'string' && modeRaw.length > 0)
    ? resolveModeNameHelper(
      modeRaw,
      nextAliases,
      getAllModesHelper('', nextPriorities, nextTargets),
    )
    : current.operatingMode;

  // Resolution-in-producer: the persisted payload may carry duplicate or gapped
  // priorities, so normalize to a strict 1..N order here. Every runtime consumer
  // (getPriorityForDevice → planSort/shedding) reads this resolved snapshot, so
  // they all inherit the strict order without branching on stored shape.
  const nextDryRun = capacityScalars.dryRun;
  const nextBehaviors = normalizeShedBehaviorsHelper(rawShedBehaviors as Record<string, ShedBehavior> | undefined);

  return {
    capacitySettings: nextCapacity,
    modeAliases: nextAliases,
    operatingMode: nextMode,
    capacityPriorities: nextPriorities,
    modeDeviceTargets: nextTargets,
    capacityDryRun: nextDryRun,
    controllableDevices: deviceFlags.controllableDevices,
    managedDevices: deviceFlags.managedDevices,
    budgetExemptDevices: deviceFlags.budgetExemptDevices,
    temperatureControlDisabledDevices: deviceFlags.temperatureControlDisabledDevices,
    temperatureControlPolicyState: deviceFlags.temperatureControlPolicyState,
    temperatureBoostSettings: normalizeTemperatureBoostSettings(rawTemperatureBoostSettings),
    evBoostSettings: normalizeEvBoostSettings(rawEvBoostSettings),
    evCarAssociations: normalizeEvCarAssociations(rawEvCarAssociations),
    nativeEvWiringDevices: nativeEvSettings.nativeEvWiringDevices,
    deviceDriverOverrides: deviceOverrides.deviceDriverOverrides,
    deviceControlProfiles: deviceSettings.deviceControlProfiles,
    deviceTargetPowerConfigs: deviceSettings.deviceTargetPowerConfigs,
    deviceCommunicationModels: deviceSettings.deviceCommunicationModels,
    shedBehaviors: nextBehaviors,
  };
}

function readDeviceFlagSettings(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): Pick<
  CapacitySettingsSnapshot,
  | 'controllableDevices'
  | 'managedDevices'
  | 'budgetExemptDevices'
  | 'temperatureControlDisabledDevices'
  | 'temperatureControlPolicyState'
> {
  const { settings, current } = params;
  const controllables = settings.get(CONTROLLABLE_DEVICES) as unknown;
  const managed = settings.get(MANAGED_DEVICES) as unknown;
  const budgetExempt = settings.get(BUDGET_EXEMPT_DEVICES) as unknown;
  const temperatureControlPolicy = readTemperatureControlDisabledDevicesSetting({
    settings,
    current: {
      devices: current.temperatureControlDisabledDevices,
      state: current.temperatureControlPolicyState,
    },
  });
  return {
    controllableDevices: isBooleanMap(controllables) ? controllables : current.controllableDevices,
    managedDevices: isBooleanMap(managed) ? managed : current.managedDevices,
    budgetExemptDevices: isBooleanMap(budgetExempt) ? budgetExempt : current.budgetExemptDevices,
    temperatureControlDisabledDevices: temperatureControlPolicy.devices,
    temperatureControlPolicyState: temperatureControlPolicy.state,
  };
}

function readNativeEvSettings(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): Pick<
  CapacitySettingsSnapshot,
  'nativeEvWiringDevices'
> {
  const { settings, current } = params;
  const nativeEvWiring = settings.get(NATIVE_EV_WIRING_DEVICES) as unknown;
  return {
    nativeEvWiringDevices: isBooleanMap(nativeEvWiring)
      ? nativeEvWiring
      : current.nativeEvWiringDevices,
  };
}

function readDeviceOverrideSettings(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): Pick<
  CapacitySettingsSnapshot,
  'deviceDriverOverrides'
> {
  const { settings, current } = params;
  const driverOverrides = settings.get(DEVICE_DRIVER_OVERRIDES) as unknown;
  return {
    deviceDriverOverrides: isStringMap(driverOverrides)
      ? normalizeStringMap(driverOverrides)
      : current.deviceDriverOverrides,
  };
}

function readDeviceControlSettings(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): Pick<
  CapacitySettingsSnapshot,
  'deviceControlProfiles' | 'deviceTargetPowerConfigs' | 'deviceCommunicationModels'
> {
  const { settings, current } = params;
  const deviceControlProfiles = settings.get(DEVICE_CONTROL_PROFILES) as unknown;
  const deviceTargetPowerConfigs = settings.get(DEVICE_TARGET_POWER_CONFIGS) as unknown;
  const targetPowerReachability = settings.get(DEVICE_TARGET_POWER_REACHABILITY) as unknown;
  const deviceCommunicationModels = settings.get(DEVICE_COMMUNICATION_MODELS) as unknown;
  const targetPowerConfigSetting = parseRecordSetting(deviceTargetPowerConfigs);
  const normalizedTargetPowerConfigs = targetPowerConfigSetting
    ? normalizeDeviceTargetPowerConfigs(targetPowerConfigSetting)
    : undefined;
  const reachabilityByDevice = normalizeCompleteTargetPowerReachabilityByDevice(targetPowerReachability) ?? {};
  const currentReachabilityByDevice = Object.fromEntries(
    Object.entries(current.deviceTargetPowerConfigs).flatMap(([deviceId, config]) => (
      config.reachability ? [[deviceId, config.reachability]] : []
    )),
  );
  return {
    deviceControlProfiles: isDeviceControlProfiles(deviceControlProfiles)
      ? deviceControlProfiles
      : current.deviceControlProfiles,
    deviceTargetPowerConfigs: normalizedTargetPowerConfigs
      ? joinTargetPowerReachability(
        normalizedTargetPowerConfigs,
        reachabilityByDevice,
        currentReachabilityByDevice,
      )
      : current.deviceTargetPowerConfigs,
    deviceCommunicationModels: isCommunicationModelMap(deviceCommunicationModels)
      ? deviceCommunicationModels
      : current.deviceCommunicationModels,
  };
}

function joinTargetPowerReachability(
  configs: DeviceTargetPowerConfigsWithReachability,
  reachabilityByDevice: Record<string, TargetPowerReachabilityState>,
  currentReachabilityByDevice: Record<string, TargetPowerReachabilityState>,
): DeviceTargetPowerConfigsWithReachability {
  return Object.fromEntries(Object.entries(configs).map(([deviceId, config]) => {
    const reachability = currentReachabilityByDevice[deviceId] ?? reachabilityByDevice[deviceId];
    if (!reachability) return [deviceId, config];
    const joined = { ...config, reachability };
    return resolveValidTargetPowerReachability(joined)
      ? [deviceId, joined]
      : [deviceId, config];
  }));
}

function parseRecordSetting(value: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainObject(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function normalizeStringMap(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalizedKey = key.trim();
      const normalizedEntry = entry.trim();
      return normalizedKey && normalizedEntry ? [[normalizedKey, normalizedEntry]] : [];
    }),
  );
}

export function loadCapacitySettingsFromHomey(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): CapacitySettingsSnapshot {
  const { settings, current } = params;
  return buildCapacitySettingsSnapshot({ settings, current });
}

function requirePriceCoordinator(ctx: AppContext): PriceCoordinator {
  if (!ctx.priceCoordinator) {
    throw new Error('PriceCoordinator must be initialized before settings handler setup.');
  }
  return ctx.priceCoordinator;
}

function requirePlanService(ctx: AppContext) {
  if (!ctx.planService) {
    throw new Error('PlanService must be initialized before settings handler setup.');
  }
  return ctx.planService;
}

function requireDailyBudgetService(ctx: AppContext) {
  if (!ctx.dailyBudgetService) {
    throw new Error('DailyBudgetService must be initialized before settings handler setup.');
  }
  return ctx.dailyBudgetService;
}

export function initSettingsHandlerForApp(
  ctx: AppContext,
  options?: {
    /**
     * Receives writes to home-suffixed settings keys (`<base>:<homeId>`,
     * non-main home) instead of the main-home handlers. Wired to the
     * home-runtime registry by `AppServiceWiring.initSettingsHandler`.
     * Consumer contract (unserialized, un-deduped, idempotent dirty-marks)
     * documented on `SettingsHandlerDeps.onHomeScopedSettingChanged`.
     */
    onHomeScopedSettingChanged?: (baseKey: string, homeId: string) => void | Promise<void>;
    /** Reconcile the per-home capacity bundles after a `homes_config` write. */
    reconcileHomeRuntimes?: () => void;
    /** Rebuild pre-migration area followers after a Main catalog write. */
    rebuildHomeRuntimePlansForModeChange?: () => void;
    /** Rebuild every live sub-home after a global per-device control policy changes. */
    rebuildAllHomeRuntimePlansForDeviceControlChange?: () => void;
    /** Synchronously fence per-home runtimes for a newly observed source epoch. */
    onHomeRuntimePowerSourceObserved?: () => void;
    /** Replace per-home meter runtimes for the latest observed source epoch. */
    onHomeRuntimePowerSourceChanged?: () => void;
    /** Invalidate an in-flight poll at the synchronous meter-event edge. */
    onHomeyEnergyMeterObserved?: () => void;
    /** Schedule bounded Main authority repair for the observed selection. */
    onMainMeterSelectionObserved?: () => void;
    /** Close the shared homes/pins ownership generation synchronously. */
    onHomeOwnershipConfigurationObserved?: () => void;
    /** Apply the current generation after the serialized semantic recompute. */
    onHomeOwnershipConfigurationRecomputed?: () => void;
  },
): { handle: SettingsHandler; stop: () => void } {
  const planService = requirePlanService(ctx);
  const dailyBudgetService = requireDailyBudgetService(ctx);
  const settingsHandler = createSettingsHandler({
    homey: ctx.homey,
    onHomeScopedSettingChanged: options?.onHomeScopedSettingChanged,
    reconcileHomeRuntimes: options?.reconcileHomeRuntimes,
    rebuildHomeRuntimePlansForModeChange: options?.rebuildHomeRuntimePlansForModeChange,
    rebuildAllHomeRuntimePlansForDeviceControlChange:
      options?.rebuildAllHomeRuntimePlansForDeviceControlChange,
    onHomeRuntimePowerSourceObserved: options?.onHomeRuntimePowerSourceObserved,
    onHomeRuntimePowerSourceChanged: options?.onHomeRuntimePowerSourceChanged,
    onTemperatureControlPolicyObserved: ctx.loadTemperatureControlPolicySettings,
    onHomeyEnergyMeterObserved: options?.onHomeyEnergyMeterObserved,
    onMainMeterSelectionObserved: options?.onMainMeterSelectionObserved,
    onHomeOwnershipConfigurationObserved: options?.onHomeOwnershipConfigurationObserved,
    // Lazy read on purpose: the membership service is assigned by a separate
    // wiring step, and the handler must tolerate a context without it.
    recomputeHomeMembership: () => {
      ctx.homeMembership?.recompute();
      options?.onHomeOwnershipConfigurationRecomputed?.();
    },
    loadCapacitySettings: ctx.loadCapacitySettings,
    rebuildPlanFromCache: async (reason) => {
      await planService.rebuildPlanFromCache(reason);
    },
    refreshTargetDevicesSnapshot: () => ctx.refreshTargetDevicesSnapshot(),
    loadPowerTracker: () => ctx.loadPowerTracker(),
    getCapacityGuard: () => ctx.capacityGuard,
    getCapacitySettings: () => ctx.capacitySettings,
    getCapacityDryRun: () => ctx.capacityDryRun,
    loadPriceOptimizationSettings: ctx.loadPriceOptimizationSettings,
    loadDailyBudgetSettings: () => dailyBudgetService.loadSettings(),
    updateDailyBudgetState: (options) => ctx.updateDailyBudgetState(options),
    resetDailyBudgetLearning: () => dailyBudgetService.resetLearning(),
    priceService: requirePriceCoordinator(ctx),
    updatePriceOptimizationEnabled: ctx.updatePriceOptimizationEnabled,
    updateOverheadToken: ctx.updateOverheadToken,
    updateDebugLoggingEnabled: ctx.updateDebugLoggingEnabled,
    restartHomeyEnergyPoll: () => {
      ctx.homeyEnergyHelpers.restart();
      // The two are complementary: exactly one runs for any given source, so a
      // source change must re-evaluate both or the home ends up with neither.
      ctx.generationPollSource.restart();
    },
    stopFlowPowerSampleFreshnessClock: () => stopFlowPowerSampleFreshnessClock(ctx.timers),
    syncFlowPowerSampleFreshnessClock: () => syncFlowPowerSampleFreshnessClock(
      ctx.timers,
      ctx.powerTracker.lastTimestamp,
    ),
    reloadWeatherAdvisor: () => ctx.reloadWeatherCollector?.(),
    releaseDeOptedExternalOffHolds: () => ctx.externalOffHold?.releaseDeOptedHolds() ?? [],
    reloadExpectedPowerOverrides: () => ctx.reloadExpectedPowerOverrides(),
  });
  const onSettingsSet = async (key: string) => {
    await settingsHandler?.(key);
    if (key === OPERATING_MODE_SETTING) {
      ctx.notifyOperatingModeChanged(ctx.operatingMode);
    }
  };
  ctx.homey.settings.on('set', onSettingsSet);
  const modeCatalogKeys = new Set([
    OPERATING_MODE_SETTING,
    MODE_ALIASES,
    CAPACITY_PRIORITIES,
    MODE_DEVICE_TARGETS,
    MODE_CATALOG_INITIALIZED,
  ]);
  const onSettingsUnset = async (key: string) => {
    const scoped = parseHomeScopedSettingsKey(key);
    const modeCatalogKey = modeCatalogKeys.has(scoped.baseKey);
    if (scoped.homeId === MAIN_HOME_ID || !modeCatalogKey) return;
    await settingsHandler?.(key);
  };
  ctx.homey.settings.on('unset', onSettingsUnset);
  return {
    handle: settingsHandler,
    stop: () => {
      ctx.homey.settings.off('set', onSettingsSet);
      ctx.homey.settings.off('unset', onSettingsUnset);
      settingsHandler.stop();
    },
  };
}
