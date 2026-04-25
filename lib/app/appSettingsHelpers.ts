import type Homey from 'homey';
import type { ShedBehavior } from '../plan/planTypes';
import type { DeviceControlProfiles } from '../utils/types';
import {
  normalizeShedBehaviors as normalizeShedBehaviorsHelper,
  resolveModeName as resolveModeNameHelper,
} from '../utils/capacityHelpers';
import { createSettingsHandler } from '../utils/settingsHandlers';
import {
  isDeviceControlProfiles,
  isBooleanMap,
  isCommunicationModelMap,
  isFiniteNumber,
  isModeDeviceTargets,
  isPrioritySettings,
  isStringMap,
} from '../utils/appTypeGuards';
import {
  BUDGET_EXEMPT_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEVICE_CONTROL_PROFILES,
  DEVICE_COMMUNICATION_MODELS,
  DEVICE_DRIVER_OVERRIDES,
  EXPERIMENTAL_EV_SUPPORT_ENABLED,
  NATIVE_EV_WIRING_DEVICES,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../utils/settingsKeys';
import type { PriceCoordinator } from '../price/priceCoordinator';
import type { SettingsHandler } from '../utils/settingsHandlers';
import type { AppContext } from './appContext';

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
  nativeEvWiringDevices: Record<string, boolean>;
  deviceDriverOverrides: Record<string, string>;
  deviceControlProfiles: DeviceControlProfiles;
  deviceCommunicationModels: Record<string, 'local' | 'cloud'>;
  experimentalEvSupportEnabled: boolean;
  shedBehaviors: Record<string, ShedBehavior>;
};

export function buildCapacitySettingsSnapshot(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): CapacitySettingsSnapshot {
  const { settings, current } = params;
  const limit = settings.get(CAPACITY_LIMIT_KW) as unknown;
  const margin = settings.get(CAPACITY_MARGIN_KW) as unknown;
  const modeRaw = settings.get(OPERATING_MODE_SETTING) as unknown;
  const modeAliases = settings.get('mode_aliases') as unknown;
  const priorities = settings.get('capacity_priorities') as unknown;
  const modeTargets = settings.get('mode_device_targets') as unknown;
  const dryRun = settings.get(CAPACITY_DRY_RUN) as unknown;
  const deviceFlags = readDeviceFlagSettings({ settings, current });
  const deviceSettings = readDeviceControlSettings({ settings, current });
  const deviceOverrides = readDeviceOverrideSettings({ settings, current });
  const nativeEvSettings = readNativeEvSettings({ settings, current });
  const experimentalEvSupportEnabled = settings.get(EXPERIMENTAL_EV_SUPPORT_ENABLED) as unknown;
  const rawShedBehaviors = settings.get(OVERSHOOT_BEHAVIORS) as unknown;

  const nextCapacity = {
    limitKw: isFiniteNumber(limit) ? limit : current.capacitySettings.limitKw,
    marginKw: isFiniteNumber(margin) ? margin : current.capacitySettings.marginKw,
  };

  const nextAliases = isStringMap(modeAliases)
    ? Object.fromEntries(
      Object.entries(modeAliases).map(([k, v]) => [k.toLowerCase(), v]),
    )
    : current.modeAliases;

  const nextMode = (typeof modeRaw === 'string' && modeRaw.length > 0)
    ? resolveModeNameHelper(modeRaw, nextAliases)
    : current.operatingMode;

  const nextPriorities = isPrioritySettings(priorities) ? priorities : current.capacityPriorities;
  const nextTargets = isModeDeviceTargets(modeTargets) ? modeTargets : current.modeDeviceTargets;
  const nextDryRun = typeof dryRun === 'boolean' ? dryRun : current.capacityDryRun;
  const nextExperimentalEvSupportEnabled = typeof experimentalEvSupportEnabled === 'boolean'
    ? experimentalEvSupportEnabled
    : current.experimentalEvSupportEnabled;
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
    nativeEvWiringDevices: nativeEvSettings.nativeEvWiringDevices,
    deviceDriverOverrides: deviceOverrides.deviceDriverOverrides,
    deviceControlProfiles: deviceSettings.deviceControlProfiles,
    deviceCommunicationModels: deviceSettings.deviceCommunicationModels,
    experimentalEvSupportEnabled: nextExperimentalEvSupportEnabled,
    shedBehaviors: nextBehaviors,
  };
}

function readDeviceFlagSettings(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): Pick<
  CapacitySettingsSnapshot,
  'controllableDevices' | 'managedDevices' | 'budgetExemptDevices'
> {
  const { settings, current } = params;
  const controllables = settings.get(CONTROLLABLE_DEVICES) as unknown;
  const managed = settings.get(MANAGED_DEVICES) as unknown;
  const budgetExempt = settings.get(BUDGET_EXEMPT_DEVICES) as unknown;
  return {
    controllableDevices: isBooleanMap(controllables) ? controllables : current.controllableDevices,
    managedDevices: isBooleanMap(managed) ? managed : current.managedDevices,
    budgetExemptDevices: isBooleanMap(budgetExempt) ? budgetExempt : current.budgetExemptDevices,
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
  'deviceControlProfiles' | 'deviceCommunicationModels'
> {
  const { settings, current } = params;
  const deviceControlProfiles = settings.get(DEVICE_CONTROL_PROFILES) as unknown;
  const deviceCommunicationModels = settings.get(DEVICE_COMMUNICATION_MODELS) as unknown;
  return {
    deviceControlProfiles: isDeviceControlProfiles(deviceControlProfiles)
      ? deviceControlProfiles
      : current.deviceControlProfiles,
    deviceCommunicationModels: isCommunicationModelMap(deviceCommunicationModels)
      ? deviceCommunicationModels
      : current.deviceCommunicationModels,
  };
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

export function initSettingsHandlerForApp(ctx: AppContext): { handle: SettingsHandler; stop: () => void } {
  const planService = requirePlanService(ctx);
  const dailyBudgetService = requireDailyBudgetService(ctx);
  const settingsHandler = createSettingsHandler({
    homey: ctx.homey,
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
    getExperimentalEvSupportEnabled: () => ctx.experimentalEvSupportEnabled,
    disableManagedEvDevices: ctx.disableManagedEvDevices,
    restartHomeyEnergyPoll: () => ctx.homeyEnergyHelpers.restart(),
    log: (message: string) => ctx.log(message),
    errorLog: (message: string, err: unknown) => ctx.error(message, err as Error),
  });
  const onSettingsSet = async (key: string) => {
    await settingsHandler?.(key);
    if (key === OPERATING_MODE_SETTING) {
      ctx.notifyOperatingModeChanged(ctx.operatingMode);
    }
  };
  ctx.homey.settings.on('set', onSettingsSet);
  return {
    handle: settingsHandler,
    stop: () => {
      ctx.homey.settings.off('set', onSettingsSet);
      settingsHandler.stop();
    },
  };
}
