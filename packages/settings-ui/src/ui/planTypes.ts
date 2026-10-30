import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanSnapshot,
} from '../../../contracts/src/settingsUi/plan.ts';

export type PlanMetaSnapshot = SettingsUiPlanMetaSnapshot;

export type PlanDeviceSnapshot = SettingsUiPlanDeviceSnapshot;

export type PlanSnapshot = Omit<SettingsUiPlanSnapshot, 'devices'> & {
  devices?: PlanDeviceSnapshot[];
};

