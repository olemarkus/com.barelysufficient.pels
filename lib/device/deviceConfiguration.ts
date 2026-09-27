/**
 * Runtime configuration needed to plan and execute device work. This source
 * owns the resolved control and power settings; live state stays on Observer.
 * It is refreshed from DeviceTransport's accepted snapshot so runtime
 * consumers do not use the inventory API to assemble their inputs.
 */
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';

export type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';

export type DeviceConfiguration = {
  get(deviceId: string): DeviceConfigurationRead | undefined;
  getAll(): DeviceConfigurationRead[];
  ids(): string[];
};

const resolveConfiguration = (snapshot: TransportDeviceSnapshot): DeviceConfigurationRead => ({
    id: snapshot.id,
    name: snapshot.name,
    controlModel: snapshot.controlModel,
    controlAdapter: snapshot.controlAdapter,
    binaryControllable: snapshot.binaryControllable,
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
  });

export class DeviceConfigurationStore implements DeviceConfiguration {
  private readonly byId = new Map<string, DeviceConfigurationRead>();

  get(deviceId: string): DeviceConfigurationRead | undefined {
    return this.byId.get(deviceId);
  }

  getAll(): DeviceConfigurationRead[] {
    return [...this.byId.values()];
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
