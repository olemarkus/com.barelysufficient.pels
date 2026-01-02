import type Homey from 'homey';
import type CapacityGuard from '../core/capacityGuard';
import type { DeviceManager } from '../core/deviceManager';
import type { PowerTrackerState } from '../core/powerTracker';
import type { PriceOptimizationSettings } from '../price/priceOptimizer';
import type { PriceLevel } from '../price/priceLevels';
import type { PlanEngine } from '../plan/planEngine';
import { PlanService } from '../plan/planService';
import { PlanEngine as PlanEngineClass } from '../plan/planEngine';
import type { ShedAction } from '../plan/planTypes';
import type { FlowHomeyLike, TargetDeviceSnapshot } from '../utils/types';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import type { DebugLoggingTopic } from '../utils/debugLogging';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { COMBINED_PRICES } from '../utils/settingsKeys';
import type { CapacitySettingsSnapshot } from './appSettingsHelpers';

export type { CapacitySettingsSnapshot };

export type PlanEngineInitApp = {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot: () => DailyBudgetUiPayload | null;
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
    getCapacityGuard: () => app.getCapacityGuard(),
    getCapacitySettings: () => app.getCapacitySettings(),
    getCapacityDryRun: () => app.getCapacityDryRun(),
    getOperatingMode: () => app.getOperatingMode(),
    getModeDeviceTargets: () => app.getModeDeviceTargets(),
    getPriceOptimizationEnabled: () => app.getPriceOptimizationEnabled(),
    getPriceOptimizationSettings: () => app.getPriceOptimizationSettings(),
    isCurrentHourCheap: () => app.isCurrentHourCheap(),
    isCurrentHourExpensive: () => app.isCurrentHourExpensive(),
    getPowerTracker: () => app.getPowerTracker(),
    getDailyBudgetSnapshot: () => app.getDailyBudgetSnapshot(),
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
  getCapacityDryRun: () => boolean;
  getLastPowerUpdate: () => number | null;
  getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
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
    getPlanDevices: () => app.getLatestTargetSnapshot().map((device) => ({
      ...device,
      managed: app.resolveManagedState(device.id),
      controllable: app.isCapacityControlEnabled(device.id),
    })).filter((device) => device.managed !== false),
    getCapacityDryRun: () => app.getCapacityDryRun(),
    log: (...args: unknown[]) => app.log(...args),
    logDebug: (...args: unknown[]) => app.logDebug('plan', ...args),
    error: (...args: unknown[]) => app.error(...args),
    isCurrentHourCheap: () => app.isCurrentHourCheap(),
    isCurrentHourExpensive: () => app.isCurrentHourExpensive(),
    getCombinedPrices: () => app.homey.settings.get(COMBINED_PRICES) as unknown,
    getLastPowerUpdate: () => app.getLastPowerUpdate(),
  });
}

export type FlowCardInitApp = {
  homey: Homey.App['homey'];
  resolveModeName: (mode: string) => string;
  getAllModes: () => Set<string>;
  getOperatingMode: () => string;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getCurrentPriceLevel: () => PriceLevel;
  recordPowerSample: (powerW: number) => Promise<void>;
  capacityGuard?: CapacityGuard;
  getFlowSnapshot: () => Promise<TargetDeviceSnapshot[]>;
  refreshTargetDevicesSnapshot: () => Promise<void>;
  getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
  setExpectedOverride: (deviceId: string, kw: number) => void;
  storeFlowPriceData: (kind: 'today' | 'tomorrow', raw: unknown) => {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  };
  planService: PlanService;
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: { forcePlanRebuild?: boolean }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => void;
};

export function registerAppFlowCards(app: FlowCardInitApp): void {
  registerFlowCards({
    homey: app.homey as FlowHomeyLike,
    resolveModeName: (mode) => app.resolveModeName(mode),
    getAllModes: () => app.getAllModes(),
    getCurrentOperatingMode: () => app.getOperatingMode(),
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
    storeFlowPriceData: (kind, raw) => app.storeFlowPriceData(kind, raw),
    rebuildPlan: () => app.planService.rebuildPlanFromCache(),
    loadDailyBudgetSettings: () => app.loadDailyBudgetSettings(),
    updateDailyBudgetState: (options) => app.updateDailyBudgetState(options),
    log: (...args: unknown[]) => app.log(...args),
    logDebug: (...args: unknown[]) => app.logDebug('settings', ...args),
  });
}
