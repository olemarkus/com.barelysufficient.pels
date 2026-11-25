import type { CarIdentificationState } from '../../packages/contracts/src/evCarLink';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUi/plan';
import type { IdleClassification } from '../../packages/contracts/src/idleClassification';
import type { DeviceOverviewSnapshot } from '../../packages/contracts/src/deviceOverview';
import type { PreparedModeTarget, PriceTargetShift } from '../../packages/planner-types/src/temperatureSetpoints';
import type { AdapterUnavailableStatus, DeviceControlAdapterSnapshot } from '../../packages/contracts/src/types';
import type { UnusedBuiltInControl } from '../device/builtInControlFlowGate';
import type { DevicePlanDevice } from './planTypes';
import type { DevicePowerSetupRequirement } from '../ports/deviceConfigurationRead';

/** The installation context shown alongside a charger's own draw. */
export type ChargingInstallationCard =
  | { role: 'main'; totalKw: number | undefined }
  | { role: 'secondary'; mainName: string | undefined };

export type DeviceStatusInput = DeviceOverviewSnapshot & {
  /** The adapter's live presentation, independently of its plan-time configuration. */
  adapterUnavailableStatus: AdapterUnavailableStatus | undefined;
  /** The charger's place on a charging installation PELS controls as one load. */
  chargingInstallation: ChargingInstallationCard | undefined;
  /** Why PELS does not set the level itself although it could. */
  unusedBuiltInControl: UnusedBuiltInControl;
  /** The device's app refused Homey's control of its power level, so PELS only switches it. */
  targetPowerControlRefused: boolean;
  /**
   * The owner granted PELS standing authority over the device: Power-limit
   * control, or "Only PELS starts this device" (`hasStandingCommandGrant`).
   * Read now, from the settings that seed the plan's authority.
   */
  standingCommandGrant: boolean;
  powerLimitControlEnabled: boolean;
  /** The plan had a power reading for the device (`isMeteredPlanDevice`), which authority also takes. */
  hasPowerReading: boolean;
  /** The observer's last live device power reading when it predates switch-off. */
  powerBeforeSwitchOffKw: number | undefined;
  /** The device owner's resolved power setup requirement. */
  powerSetupRequirement: DevicePowerSetupRequirement | null;
  carIdentificationState: CarIdentificationState;
  execution: DeviceExecutionState;
  starvation?: SettingsUiPlanDeviceStarvation;
  idleClassification?: IdleClassification;
  /** The plan device's own fact (`DevicePlanDevice.priceTargetShift`), spread in with it. */
  priceTargetShift: PriceTargetShift;
  /** The plan device's own fact (`DevicePlanDevice.temporaryTemperatureActive`), spread in with it. */
  temporaryTemperatureActive?: boolean;
  modePreparation?: PreparedModeTarget;
  /** The plan device's control adapter, spread in with it; absent on a device that has none. */
  controlAdapter?: DeviceControlAdapterSnapshot;
} & Pick<DevicePlanDevice, 'steppedFairnessHold' | 'steppedStepUpHold' | 'startPolicyHoldActive'>
  & Partial<Pick<DevicePlanDevice, 'phaseFootprint' | 'lastResort' | 'lastResortOwnedOffAtMs'>>;
