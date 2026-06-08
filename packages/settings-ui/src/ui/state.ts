import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  DeviceTargetPowerConfigs,
  EvBoostConfig,
  EvBoostSettings,
  TemperatureBoostConfig,
  TemperatureBoostSettings,
} from '../../../contracts/src/types.ts';
import {
  createEmptyDeferredObjectiveSettings,
  type DeferredObjectiveSettingsV1,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { OverviewDeferredObjectiveActivePlans } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { DEFAULT_MODE_NAME } from '../../../shared-domain/src/modeLabels.ts';

export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';
export type ShedBehavior = {
  action: ShedAction;
  temperature?: number;
  stepId?: string;
};

export type PriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
};

/**
 * Settings-UI device view: the decorated backend snapshot plus the UI's own
 * optimistic mirror of boost config. `temperatureBoost`/`evBoost` are NOT part
 * of the backend snapshot contract — the planner sources boost via the app
 * context (`ctx.get*BoostConfig`), and the UI's authoritative source is
 * `state.{temperature,ev}BoostSettings`. The device-detail handlers write these
 * onto the live device object optimistically after a successful settings write.
 */
export type SettingsUiDeviceView = DecoratedDeviceSnapshot & {
  temperatureBoost?: TemperatureBoostConfig;
  evBoost?: EvBoostConfig;
};

export type UiState = {
  isBusy: boolean;
  initialLoadComplete: boolean;
  devicesLoaded: boolean;
  devicesLoading: boolean;
  dryRun: boolean;
  capacityPriorities: Record<string, Record<string, number>>;
  activeMode: string;
  editingMode: string;
  latestDevices: SettingsUiDeviceView[];
  modeTargets: Record<string, Record<string, number>>;
  controllableMap: Record<string, boolean>;
  managedMap: Record<string, boolean>;
  budgetExemptMap: Record<string, boolean>;
  nativeWiringMap: Record<string, boolean>;
  deviceControlProfiles: DeviceControlProfiles;
  deviceTargetPowerConfigs: DeviceTargetPowerConfigs;
  modeAliases: Record<string, string>;
  shedBehaviors: Record<string, ShedBehavior>;
  temperatureBoostSettings: TemperatureBoostSettings;
  evBoostSettings: EvBoostSettings;
  deferredObjectiveSettings: DeferredObjectiveSettingsV1;
  deferredObjectiveActivePlans: OverviewDeferredObjectiveActivePlans | null;
  priceOptimizationSettings: Record<string, PriceOptimizationConfig>;
};

export const defaultPriceOptimizationConfig: PriceOptimizationConfig = {
  enabled: false,
  cheapDelta: 5,
  expensiveDelta: -5,
};


export const state: UiState = {
  isBusy: false,
  initialLoadComplete: false,
  devicesLoaded: false,
  devicesLoading: false,
  dryRun: false,
  capacityPriorities: {},
  activeMode: DEFAULT_MODE_NAME,
  editingMode: DEFAULT_MODE_NAME,
  latestDevices: [],
  modeTargets: {},
  controllableMap: {},
  managedMap: {},
  budgetExemptMap: {},
  nativeWiringMap: {},
  deviceControlProfiles: {},
  deviceTargetPowerConfigs: {},
  modeAliases: {},
  shedBehaviors: {},
  temperatureBoostSettings: {},
  evBoostSettings: {},
  deferredObjectiveSettings: createEmptyDeferredObjectiveSettings(),
  deferredObjectiveActivePlans: null,
  priceOptimizationSettings: {},
};

export const resolveManagedState = (deviceId: string): boolean => {
  return state.managedMap[deviceId] === true;
};
