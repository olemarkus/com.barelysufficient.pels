import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanSnapshot,
} from '../../../contracts/src/settingsUiApi.ts';

export type PlanMetaSnapshot = SettingsUiPlanMetaSnapshot;

export type PlanDeviceSnapshot = SettingsUiPlanDeviceSnapshot;

export type PlanSnapshot = Omit<SettingsUiPlanSnapshot, 'devices'> & {
  devices?: PlanDeviceSnapshot[];
};

