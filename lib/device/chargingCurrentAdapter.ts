import { getDeviceAdapter } from './deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../utils/types';
import type { HomeyFlowAction } from './transport/homeyActionAccess';
import { readFlowActionCardIds, resolveDeviceActionCard } from './flowActionCards';

import type { ChargingCurrentBinding } from './deviceAdapter';

export function resolveChargingCurrentAdapter(device: HomeyDeviceLike): ChargingCurrentBinding | undefined {
  return getDeviceAdapter(device).currentBindings(device)[0];
}

/** Exact device-owned driver card, resolved from installed Homey metadata. */
export function resolveChargingCurrentAction(
  adapter: ChargingCurrentBinding,
  inventory: unknown,
  currentA: number,
): HomeyFlowAction {
  if (!Number.isInteger(currentA) || currentA < 6 || currentA > 32) throw new Error('Charging current must be 6–32 A.');
  const action = resolveDeviceActionCard(readFlowActionCardIds(inventory), adapter.appUri, {
    deviceId: adapter.deviceId, actionId: adapter.actionId, args: adapter.currentArguments(currentA),
  });
  if (!action) throw new Error('The charging-current action is unavailable in Homey.');
  return action;
}

export function hasSharedChargingInstallation(
  adapter: ChargingCurrentBinding,
  devices: readonly HomeyDeviceLike[],
): boolean {
  const { scope } = adapter;
  return scope.kind === 'installation' && devices.some((device) => device.id !== adapter.deviceId
    && adapter.sharesInstallation(device));
}
