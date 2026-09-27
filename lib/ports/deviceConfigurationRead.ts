import type { DeviceDescriptorRead } from '../../packages/contracts/src/types';

/** Resolved configuration needed by planner and executor runtime inputs. */
export type DeviceConfigurationRead = {
  id: string;
  name: string;
  controlModel?: DeviceDescriptorRead['controlModel'];
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
