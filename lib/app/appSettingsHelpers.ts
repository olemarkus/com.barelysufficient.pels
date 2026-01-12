import type Homey from 'homey';
import type { ShedBehavior } from '../plan/planTypes';
import { normalizeShedBehaviors as normalizeShedBehaviorsHelper, resolveModeName as resolveModeNameHelper } from '../utils/capacityHelpers';
import { createSettingsHandler } from '../utils/settingsHandlers';
import { isBooleanMap, isFiniteNumber, isModeDeviceTargets, isPrioritySettings, isStringMap } from '../utils/appTypeGuards';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, MANAGED_DEVICES, OPERATING_MODE_SETTING } from '../utils/settingsKeys';
import type { PriceCoordinator } from '../price/priceCoordinator';
import type CapacityGuard from '../core/capacityGuard';

export type CapacitySettingsSnapshot = {
  capacitySettings: { limitKw: number; marginKw: number };
  modeAliases: Record<string, string>;
  operatingMode: string;
  capacityPriorities: Record<string, Record<string, number>>;
  modeDeviceTargets: Record<string, Record<string, number>>;
  capacityDryRun: boolean;
  controllableDevices: Record<string, boolean>;
  managedDevices: Record<string, boolean>;
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
  const controllables = settings.get('controllable_devices') as unknown;
  const managed = settings.get(MANAGED_DEVICES) as unknown;
  const rawShedBehaviors = settings.get('overshoot_behaviors') as unknown;

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
  const nextControllables = isBooleanMap(controllables) ? controllables : current.controllableDevices;
  const nextManaged = isBooleanMap(managed) ? managed : current.managedDevices;
  const nextBehaviors = normalizeShedBehaviorsHelper(rawShedBehaviors as Record<string, ShedBehavior> | undefined);

  return {
    capacitySettings: nextCapacity,
    modeAliases: nextAliases,
    operatingMode: nextMode,
    capacityPriorities: nextPriorities,
    modeDeviceTargets: nextTargets,
    capacityDryRun: nextDryRun,
    controllableDevices: nextControllables,
    managedDevices: nextManaged,
    shedBehaviors: nextBehaviors,
  };
}

export function loadCapacitySettingsFromHomey(params: {
  settings: Homey.App['homey']['settings'];
  current: CapacitySettingsSnapshot;
}): CapacitySettingsSnapshot {
  const { settings, current } = params;
  return buildCapacitySettingsSnapshot({ settings, current });
}

export function initSettingsHandlerForApp(params: {
  homey: Homey.App['homey'];
  getOperatingMode: () => string;
  notifyOperatingModeChanged: (mode: string) => void;
  loadCapacitySettings: () => void;
  rebuildPlanFromCache: () => Promise<void>;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  loadPowerTracker: () => void;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  loadPriceOptimizationSettings: () => void;
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: { forcePlanRebuild?: boolean }) => void;
  resetDailyBudgetLearning: () => void;
  priceService: PriceCoordinator;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  log: (message: string) => void;
  error: (message: string, error: Error) => void;
}): (key: string) => Promise<void> {
  const {
    homey,
    getOperatingMode,
    notifyOperatingModeChanged,
    loadCapacitySettings,
    rebuildPlanFromCache,
    refreshTargetDevicesSnapshot,
    loadPowerTracker,
    getCapacityGuard,
    getCapacitySettings,
    getCapacityDryRun,
    loadPriceOptimizationSettings,
    loadDailyBudgetSettings,
    updateDailyBudgetState,
    resetDailyBudgetLearning,
    priceService,
    updatePriceOptimizationEnabled,
    updateOverheadToken,
    updateDebugLoggingEnabled,
    log,
    error,
  } = params;
  const settingsHandler = createSettingsHandler({
    homey,
    loadCapacitySettings,
    rebuildPlanFromCache,
    refreshTargetDevicesSnapshot,
    loadPowerTracker,
    getCapacityGuard,
    getCapacitySettings,
    getCapacityDryRun,
    loadPriceOptimizationSettings,
    loadDailyBudgetSettings,
    updateDailyBudgetState,
    resetDailyBudgetLearning,
    priceService,
    updatePriceOptimizationEnabled,
    updateOverheadToken,
    updateDebugLoggingEnabled,
    log,
    errorLog: (message: string, err: unknown) => error(message, err as Error),
  });
  homey.settings.on('set', async (key: string) => {
    await settingsHandler?.(key);
    if (key === OPERATING_MODE_SETTING) {
      notifyOperatingModeChanged(getOperatingMode());
    }
  });
  return settingsHandler;
}
