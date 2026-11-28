import type { ChargingCurrentSetup } from '../../packages/contracts/src/chargingControl';
import type { FlowCapabilityWrites } from '../flowApi/userFlows';
import type { HomeyDeviceLike } from '../utils/types';
import { resolveChargingCurrentAdapter } from './chargingCurrentAdapter';
import type { ChargingCurrentBinding } from './deviceAdapter';
import { WATT_CONTROL_CAPABILITIES } from './targetPowerControlClaims';

/** The Flows writing this charger's amp capability or app action, by Flow id. */
export function currentSettingFlows(
  adapter: ChargingCurrentBinding, writes: FlowCapabilityWrites,
): Map<string, string> {
  const names = new Map<string, string>();
  collectFlowNames(names, writes.get(adapter.deviceId), currentSettingCapabilities(adapter));
  return names;
}

/** A Flow writing the current or watt target of any member can drive the whole installation. */
export function installationCurrentFlows(
  devices: readonly HomeyDeviceLike[], writes: FlowCapabilityWrites,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const device of devices) {
    const binding = resolveChargingCurrentAdapter(device);
    const deviceWrites = writes.get(device.id);
    collectFlowNames(names, deviceWrites, currentSettingCapabilities(binding));
    collectFlowNames(names, deviceWrites, WATT_CONTROL_CAPABILITIES);
  }
  return names;
}

export function currentSettingCapabilities(binding?: ChargingCurrentBinding): readonly string[] {
  if (!binding) return [];
  return binding.current.kind === 'capability' ? [binding.current.capabilityId, binding.actionId] : [binding.actionId];
}

function collectFlowNames(
  names: Map<string, string>, writes: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
  actions: readonly string[],
): void {
  for (const action of actions) {
    for (const [id, name] of writes?.get(action) ?? []) names.set(id, name);
  }
}

/** Built-in current actions must have a verified exclusive route and an accepted ceiling. */
export function actionControlHoldReason(
  binding: ChargingCurrentBinding | undefined,
  readSetup: () => ChargingCurrentSetup,
  flowInventoryReady: boolean,
  writes: FlowCapabilityWrites,
): string | undefined {
  if (!binding?.confirmsCurrentWithAction || readSetup().method !== 'built_in') return undefined;
  if (!flowInventoryReady) return 'Checking Homey Flows';
  if (binding.actionCurrentCeilingA === undefined && currentSettingFlows(binding, writes).size === 0) {
    return 'Waiting for the charger to report its current limit';
  }
  return undefined;
}
