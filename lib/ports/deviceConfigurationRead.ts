import type { DeviceDescriptorRead, SteppedLoadProfile } from '../../packages/contracts/src/types';

/** Resolved configuration needed by planner and executor runtime inputs. */
type DeviceConfigurationFields = {
  id: string;
  name: string;
  controlAdapter?: DeviceDescriptorRead['controlAdapter'];
  binaryControllable?: DeviceDescriptorRead['binaryControllable'];
  observeOnly: boolean;
  isEvCharger: boolean;
  capabilities?: DeviceDescriptorRead['capabilities'];
  canSetControl?: DeviceDescriptorRead['canSetControl'];
  powerCapable?: DeviceDescriptorRead['powerCapable'];
  controllable?: DeviceDescriptorRead['controllable'];
  managed?: DeviceDescriptorRead['managed'];
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
