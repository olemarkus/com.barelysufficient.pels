import { getDeviceAdapter } from './deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../utils/types';
import type { ChargingCurrentAction } from './transport/chargingAccess';

import type { ChargingCurrentBinding } from './deviceAdapter';

export function resolveChargingCurrentAdapter(device: HomeyDeviceLike): ChargingCurrentBinding | undefined {
  return getDeviceAdapter(device).currentBindings(device)[0];
}

/** Exact device-owned driver card, resolved from installed Homey metadata. */
export function resolveChargingCurrentAction(
  adapter: ChargingCurrentBinding,
  inventory: unknown,
  currentA: number,
): ChargingCurrentAction {
  if (!Number.isInteger(currentA) || currentA < 6 || currentA > 32) throw new Error('Charging current must be 6–32 A.');
  const ownerUri = `homey:device:${adapter.deviceId}`;
  const cardId = `${ownerUri}:${adapter.actionId}`;
  const cards = actionCards(inventory);
  const card = cards.find((entry) => typeof entry === 'object' && entry !== null
    && 'id' in entry && entry.id === cardId);
  if (card) return {
    ownerUri, cardId,
    args: adapter.currentArguments(currentA),
  };
  const appCardId = `${adapter.appUri}:${adapter.actionId}`;
  const appCard = cards.find((entry) => typeof entry === 'object' && entry !== null
    && 'id' in entry && entry.id === appCardId);
  if (!appCard) throw new Error('The charging-current action is unavailable in Homey.');
  return {
    ownerUri: adapter.appUri, cardId: appCardId,
    args: { device: { id: adapter.deviceId }, ...adapter.currentArguments(currentA) },
  };
}

export function hasSharedChargingInstallation(
  adapter: ChargingCurrentBinding,
  devices: readonly HomeyDeviceLike[],
): boolean {
  const { scope } = adapter;
  return scope.kind === 'installation' && devices.some((device) => device.id !== adapter.deviceId
    && adapter.sharesInstallation(device));
}

function actionCards(inventory: unknown): unknown[] {
  if (Array.isArray(inventory)) return inventory;
  if (typeof inventory === 'object' && inventory !== null) return Object.values(inventory);
  return [];
}
