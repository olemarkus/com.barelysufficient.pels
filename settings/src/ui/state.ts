import type { TargetDeviceSnapshot } from '../../../lib/utils/types';

export type ShedAction = 'turn_off' | 'set_temperature';
export type ShedBehavior = {
  action: ShedAction;
  temperature?: number;
};

export type PriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
};

export type UiState = {
  isBusy: boolean;
  capacityPriorities: Record<string, Record<string, number>>;
  activeMode: string;
  editingMode: string;
  latestDevices: TargetDeviceSnapshot[];
  modeTargets: Record<string, Record<string, number>>;
  controllableMap: Record<string, boolean>;
  managedMap: Record<string, boolean>;
  modeAliases: Record<string, string>;
  shedBehaviors: Record<string, ShedBehavior>;
  priceOptimizationSettings: Record<string, PriceOptimizationConfig>;
};

export const defaultPriceOptimizationConfig: PriceOptimizationConfig = {
  enabled: true,
  cheapDelta: 5,
  expensiveDelta: -5,
};

export const state: UiState = {
  isBusy: false,
  capacityPriorities: {},
  activeMode: 'Home',
  editingMode: 'Home',
  latestDevices: [],
  modeTargets: {},
  controllableMap: {},
  managedMap: {},
  modeAliases: {},
  shedBehaviors: {},
  priceOptimizationSettings: {},
};

export const resolveManagedState = (deviceId: string): boolean => {
  const explicit = state.managedMap[deviceId];
  if (typeof explicit === 'boolean') return explicit;
  const capacityEnabled = state.controllableMap[deviceId] !== false;
  const priceEnabled = state.priceOptimizationSettings[deviceId]?.enabled === true;
  return capacityEnabled || priceEnabled;
};
