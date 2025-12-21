import type { TargetDeviceSnapshot } from '../../../types';

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
  modeAliases: {},
  shedBehaviors: {},
  priceOptimizationSettings: {},
};
