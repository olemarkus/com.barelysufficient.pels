/**
 * Runtime configuration needed to plan and execute device work. This source
 * owns the resolved control and power settings; live state stays on Observer.
 * It is refreshed from DeviceTransport's accepted snapshot so runtime
 * consumers do not use the inventory API to assemble their inputs.
 */
import type { DeviceConfigurationRead, DevicePowerSetupRequirement } from '../ports/deviceConfigurationRead';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { resolveSetpointShedFloorC } from '../../packages/shared-domain/src/utils/airtreatmentShedTemperature';
import type { EvChargingCurrentLimitPolicy } from './evChargingCurrentLimitPolicy';
import { needsHomeyEnergySetup } from '../../packages/shared-domain/src/homeyEnergySetup';
import { isBuiltInSteppedLoadControlEnabled } from './deviceActionProjection';

export type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';

export type DeviceConfiguration = {
  get(deviceId: string): DeviceConfigurationRead | undefined;
  getAll(): DeviceConfigurationRead[];
  ids(): string[];
};

/**
 * Thermostat-family classes whose "held below target" PELS reports as
 * starvation. Resolved here, at the class's owner, into `starvationSupported`,
 * so the planner reads the flag and never the class set.
 */
const STARVATION_SUPPORTED_DEVICE_CLASSES: ReadonlySet<string> = new Set([
  'thermostat',
  'heater',
  'heatpump',
  'airconditioning',
  'airtreatment',
]);

/** Whether a device class is one PELS reports starvation for. Case-insensitive. */
export const isStarvationSupportedDeviceClass = (deviceClass: string): boolean => (
  STARVATION_SUPPORTED_DEVICE_CLASSES.has(deviceClass.trim().toLowerCase())
);

const resolvePowerSetupRequirement = (snapshot: TransportDeviceSnapshot): DevicePowerSetupRequirement | null => {
  if (!needsHomeyEnergySetup(snapshot)) return null;
  if (snapshot.externalPowerSocketId === undefined) return { kind: 'homey_energy' };
  // The transport names only an assigned socket that is listed and eligible.
  return snapshot.externalPowerSocketName === undefined
    ? { kind: 'metering_socket_unavailable' }
    : { kind: 'metering_socket', socketName: snapshot.externalPowerSocketName };
};

const resolveConfiguration = (snapshot: TransportDeviceSnapshot): DeviceConfigurationRead => {
  const fields = {
    inverterControl: snapshot.inverterControl,
    id: snapshot.id,
    name: snapshot.name,
    controlAdapter: snapshot.controlAdapter,
    binaryControllable: snapshot.binaryControllable,
    isBatteryOrSolar: snapshot.isBatteryOrSolar,
    isEvCharger: snapshot.isEvCharger,
    starvationSupported: isStarvationSupportedDeviceClass(snapshot.deviceClass),
    powerSetupRequirement: resolvePowerSetupRequirement(snapshot),
    setpointShedFloorC: resolveSetpointShedFloorC(snapshot),
    capabilities: snapshot.capabilities,
    canSetControl: snapshot.canSetControl,
    powerCapable: snapshot.powerCapable,
    controllable: snapshot.controllable,
    managed: snapshot.managed,
    budgetExempt: snapshot.budgetExempt,
    priority: snapshot.priority,
    expectedPowerKw: snapshot.expectedPowerKw,
    expectedPowerSource: snapshot.expectedPowerSource,
    targetPowerConfig: snapshot.targetPowerConfig,
  };
  const builtInSteppedLoadControl = isBuiltInSteppedLoadControlEnabled(snapshot);
  return snapshot.steppedLoadProfile
    ? {
      ...fields,
      controlModel: 'stepped_load',
      steppedLoadProfile: snapshot.steppedLoadProfile,
      manualFlowSteppedLoad: snapshot.manualFlowSteppedLoad === true && !builtInSteppedLoadControl,
      builtInSteppedLoadControl,
    }
    : { ...fields, controlModel: snapshot.deviceType === 'temperature' ? 'temperature_target' : 'binary_power' };
};

export class DeviceConfigurationStore implements DeviceConfiguration {
  private readonly byId = new Map<string, DeviceConfigurationRead>();

  constructor(
    private readonly currentLimitPolicy: Pick<EvChargingCurrentLimitPolicy, 'projectConfiguration'> = {
      projectConfiguration: (configuration) => configuration,
    },
  ) {}

  get(deviceId: string): DeviceConfigurationRead | undefined {
    const configuration = this.byId.get(deviceId);
    return configuration && this.currentLimitPolicy.projectConfiguration(configuration);
  }

  getAll(): DeviceConfigurationRead[] {
    return [...this.byId.values()].map((configuration) => this.currentLimitPolicy.projectConfiguration(configuration));
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  replace(snapshots: readonly TransportDeviceSnapshot[]): void {
    this.byId.clear();
    for (const snapshot of snapshots) this.set(snapshot);
  }

  set(snapshot: TransportDeviceSnapshot): void {
    this.byId.set(snapshot.id, resolveConfiguration(snapshot));
  }

  remove(deviceId: string): void {
    this.byId.delete(deviceId);
  }
}

export const createDeviceConfiguration = (
  getStore: () => DeviceConfigurationStore,
): DeviceConfiguration => ({
  get: (deviceId) => getStore().get(deviceId),
  getAll: () => getStore().getAll(),
  ids: () => getStore().ids(),
});
