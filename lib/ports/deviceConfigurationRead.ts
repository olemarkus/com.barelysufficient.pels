import type { DeviceDescriptorRead, SteppedLoadProfile } from '../../packages/contracts/src/types';

/** Resolved configuration needed by planner and executor runtime inputs. */
type DeviceConfigurationFields = {
  id: string;
  name: string;
  controlAdapter?: DeviceDescriptorRead['controlAdapter'];
  binaryControllable: DeviceDescriptorRead['binaryControllable'];
  // Resolved from the inventory class by the device layer, so planner and
  // executor inputs never re-read the class. All required: "absent" must not
  // be able to stand in for "no".
  isBatteryOrSolar: boolean;
  isEvCharger: DeviceDescriptorRead['isEvCharger'];
  /** A thermostat-family class whose "held below target" PELS reports as starvation. */
  starvationSupported: boolean;
  /**
   * The lowest heating limit PELS sheds this device's setpoint to when the
   * setpoint is its only way to shed (no on/off, no steps). Class-keyed:
   * higher for air treatment, whose setpoint is the supply air.
   */
  setpointShedFloorC: number;
  capabilities?: DeviceDescriptorRead['capabilities'];
  canSetControl?: DeviceDescriptorRead['canSetControl'];
  powerCapable?: DeviceDescriptorRead['powerCapable'];
  controllable?: DeviceDescriptorRead['controllable'];
  managed: DeviceDescriptorRead['managed'];
  budgetExempt?: DeviceDescriptorRead['budgetExempt'];
  priority?: DeviceDescriptorRead['priority'];
  expectedPowerKw: number;
  expectedPowerSource: DeviceDescriptorRead['expectedPowerSource'];
  targetPowerConfig?: DeviceDescriptorRead['targetPowerConfig'];
};

/** The device owner resolves the control identity and usable ladder together. */
export type DeviceConfigurationRead = DeviceConfigurationFields & (
  | { controlModel: 'stepped_load'; steppedLoadProfile: SteppedLoadProfile }
  | { controlModel: 'temperature_target' | 'binary_power' }
);
