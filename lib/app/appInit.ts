import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { DeviceManager } from '../core/deviceManager';
import type { PowerTrackerState } from '../core/powerTracker';
import type { DailyBudgetService } from '../dailyBudget/dailyBudgetService';
import type { PriceOptimizationSettings } from '../price/priceOptimizer';
import type { PriceLevel } from '../price/priceLevels';
import type { PlanEngine } from '../plan/planEngine';
import { PlanService } from '../plan/planService';
import { PlanEngine as PlanEngineClass } from '../plan/planEngine';
import type { ShedAction, ShedBehavior } from '../plan/planTypes';
import type { FlowHomeyLike, TargetDeviceSnapshot } from '../utils/types';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import type { DebugLoggingTopic } from '../utils/debugLogging';
import { normalizeShedBehaviors as normalizeShedBehaviorsHelper, resolveModeName as resolveModeNameHelper } from '../utils/capacityHelpers';
import { isBooleanMap, isFiniteNumber, isModeDeviceTargets, isPrioritySettings, isStringMap } from '../utils/appTypeGuards';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, MANAGED_DEVICES, OPERATING_MODE_SETTING } from '../utils/settingsKeys';

export type CapacitySettingsSnapshot = {
  capacitySettings: { limitKw: number; marginKw: number };
  modeAliases: Record<string, string>;
  operatingMode: string;
  capacityPriorities: Record<string, Record<string, number>>;
  modeDeviceTargets: Record<string, Record<string, number>>;
  capacityDryRun: boolean;
  controllableDevices: Record<string, boolean>;
  managedDevices: Record<string, boolean>;
  managedDefaultsDirty: boolean;
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

  let nextAliases = current.modeAliases;
  if (isStringMap(modeAliases)) {
    nextAliases = Object.fromEntries(
      Object.entries(modeAliases).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  let nextMode = current.operatingMode;
  if (typeof modeRaw === 'string' && modeRaw.length > 0) {
    nextMode = resolveModeNameHelper(modeRaw, nextAliases);
  }

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
    managedDefaultsDirty: false,
    shedBehaviors: nextBehaviors,
  };
}

export type PlanEngineInitApp = {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
  capacityGuard?: CapacityGuard;
  capacitySettings: { limitKw: number; marginKw: number };
  capacityDryRun: boolean;
  operatingMode: string;
  modeDeviceTargets: Record<string, Record<string, number>>;
  powerTracker: PowerTrackerState;
  dailyBudgetService: DailyBudgetService;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, PriceOptimizationSettings>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPriorityForDevice: (deviceId: string) => number;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  getDynamicSoftLimitOverride: () => number | null;
  applySheddingToDevice: (deviceId: string, deviceName?: string, reason?: string) => Promise<void>;
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createPlanEngine(app: PlanEngineInitApp): PlanEngine {
  return new PlanEngineClass({
    homey: app.homey,
    deviceManager: app.deviceManager,
    getCapacityGuard: () => app.capacityGuard,
    getCapacitySettings: () => app.capacitySettings,
    getCapacityDryRun: () => app.capacityDryRun,
    getOperatingMode: () => app.operatingMode,
    getModeDeviceTargets: () => app.modeDeviceTargets,
    getPriceOptimizationEnabled: () => app.getPriceOptimizationEnabled(),
    getPriceOptimizationSettings: () => app.getPriceOptimizationSettings(),
    isCurrentHourCheap: () => app.isCurrentHourCheap(),
    isCurrentHourExpensive: () => app.isCurrentHourExpensive(),
    getPowerTracker: () => app.powerTracker,
    getDailyBudgetSnapshot: () => app.dailyBudgetService.getSnapshot(),
    getPriorityForDevice: (deviceId) => app.getPriorityForDevice(deviceId),
    getShedBehavior: (deviceId) => app.getShedBehavior(deviceId),
    getDynamicSoftLimitOverride: () => app.getDynamicSoftLimitOverride(),
    applySheddingToDevice: (deviceId, deviceName, reason) => app.applySheddingToDevice(deviceId, deviceName, reason),
    updateLocalSnapshot: (deviceId, updates) => app.updateLocalSnapshot(deviceId, updates),
    log: (...args: unknown[]) => app.log(...args),
    logDebug: (...args: unknown[]) => app.logDebug('plan', ...args),
    error: (...args: unknown[]) => app.error(...args),
  });
}

export type PlanServiceInitApp = {
  homey: Homey.App['homey'];
  planEngine: PlanEngine;
  capacityDryRun: boolean;
  powerTracker: PowerTrackerState;
  latestTargetSnapshot: TargetDeviceSnapshot[];
  resolveManagedState: (deviceId: string) => boolean;
  isCapacityControlEnabled: (deviceId: string) => boolean;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  log: (...args: unknown[]) => void;
  logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createPlanService(app: PlanServiceInitApp): PlanService {
  return new PlanService({
    homey: app.homey,
    planEngine: app.planEngine,
    getPlanDevices: () => app.latestTargetSnapshot.map((device) => ({
      ...device,
      managed: app.resolveManagedState(device.id),
      controllable: app.isCapacityControlEnabled(device.id),
    })).filter((device) => device.managed !== false),
    getCapacityDryRun: () => app.capacityDryRun,
    log: (...args: unknown[]) => app.log(...args),
    logDebug: (...args: unknown[]) => app.logDebug('plan', ...args),
    error: (...args: unknown[]) => app.error(...args),
    isCurrentHourCheap: () => app.isCurrentHourCheap(),
    isCurrentHourExpensive: () => app.isCurrentHourExpensive(),
    getCombinedPrices: () => app.homey.settings.get('combined_prices') as unknown,
    getLastPowerUpdate: () => app.powerTracker.lastTimestamp ?? null,
  });
}

export type FlowCardInitApp = {
  homey: Homey.App['homey'];
  resolveModeName: (mode: string) => string;
  getAllModes: () => Set<string>;
  operatingMode: string;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getCurrentPriceLevel: () => PriceLevel;
  recordPowerSample: (powerW: number) => Promise<void>;
  capacityGuard?: CapacityGuard;
  getFlowSnapshot: () => Promise<TargetDeviceSnapshot[]>;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
  setExpectedOverride: (deviceId: string, kw: number) => void;
  planService: PlanService;
  log: (...args: unknown[]) => void;
  logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => void;
};

export function registerAppFlowCards(app: FlowCardInitApp): void {
  registerFlowCards({
    homey: app.homey as FlowHomeyLike,
    resolveModeName: (mode) => app.resolveModeName(mode),
    getAllModes: () => app.getAllModes(),
    getCurrentOperatingMode: () => app.operatingMode,
    handleOperatingModeChange: (rawMode) => app.handleOperatingModeChange(rawMode),
    getCurrentPriceLevel: () => app.getCurrentPriceLevel(),
    recordPowerSample: (powerW) => app.recordPowerSample(powerW),
    getCapacityGuard: () => app.capacityGuard,
    getHeadroom: () => app.capacityGuard?.getHeadroom() ?? null,
    setCapacityLimit: (kw) => app.capacityGuard?.setLimit(kw),
    getSnapshot: () => app.getFlowSnapshot(),
    refreshSnapshot: () => app.refreshTargetDevicesSnapshot(),
    getDeviceLoadSetting: (deviceId) => app.getDeviceLoadSetting(deviceId),
    setExpectedOverride: (deviceId, kw) => app.setExpectedOverride(deviceId, kw),
    rebuildPlan: () => app.planService.rebuildPlanFromCache(),
    log: (...args: unknown[]) => app.log(...args),
    logDebug: (...args: unknown[]) => app.logDebug('settings', ...args),
  });
}
