import type {
  SettingsUiPlanDeviceSnapshot,
  SettingsUiPlanMetaSnapshot,
  SettingsUiPlanSnapshot,
} from '../../../contracts/src/settingsUiApi.ts';
import type { DeviceReason } from '../../../shared-domain/src/planReasonSemantics.ts';
import type { PlanStateKind, PlanStateTone } from '../../../shared-domain/src/planStateLabels.ts';

export type PlanMetaSnapshot = SettingsUiPlanMetaSnapshot;

export type PlanDeviceSnapshot = SettingsUiPlanDeviceSnapshot & {
  reason?: DeviceReason;
  stateKind?: PlanStateKind;
  stateTone?: PlanStateTone;
};

export type PlanSnapshot = Omit<SettingsUiPlanSnapshot, 'devices'> & {
  devices?: PlanDeviceSnapshot[];
};

export type PlanStatusBinding = {
  device: PlanDeviceSnapshot;
  reasonEl: HTMLElement;
  chipEl: HTMLElement | null;
  cooldownProgressEl: HTMLElement | null;
};
