import type { DeviceControlProfiles, TargetDeviceSnapshot } from '../../../contracts/src/types.ts';

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

export type UiState = {
  isBusy: boolean;
  initialLoadComplete: boolean;
  devicesLoaded: boolean;
  devicesLoading: boolean;
  capacityPriorities: Record<string, Record<string, number>>;
  activeMode: string;
  editingMode: string;
  latestDevices: TargetDeviceSnapshot[];
  modeTargets: Record<string, Record<string, number>>;
  controllableMap: Record<string, boolean>;
  managedMap: Record<string, boolean>;
  budgetExemptMap: Record<string, boolean>;
  deviceControlProfiles: DeviceControlProfiles;
  modeAliases: Record<string, string>;
  shedBehaviors: Record<string, ShedBehavior>;
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
  capacityPriorities: {},
  activeMode: 'Home',
  editingMode: 'Home',
  latestDevices: [],
  modeTargets: {},
  controllableMap: {},
  managedMap: {},
  budgetExemptMap: {},
  deviceControlProfiles: {},
  modeAliases: {},
  shedBehaviors: {},
  priceOptimizationSettings: {},
};

export const resolveManagedState = (deviceId: string): boolean => {
  return state.managedMap[deviceId] === true;
};
