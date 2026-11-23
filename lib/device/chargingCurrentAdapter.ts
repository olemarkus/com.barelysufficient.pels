import { getDeviceAdapter } from './deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../utils/types';
import type { HomeyFlowAction } from './transport/homeyActionAccess';
import { resolveDeviceActionCard, type FlowActionCardIds } from './flowActionCards';

import type { ChargingCurrentBinding } from './deviceAdapter';

export function resolveChargingCurrentAdapter(device: HomeyDeviceLike): ChargingCurrentBinding | undefined {
  return getDeviceAdapter(device).currentBindings(device)[0];
}

/**
 * Whether the installed app gives PELS a way to set the current: a capability its
 * metadata marks writable, or an app action PELS runs. A saved built-in choice
 * without either sets nothing.
 */
export function canSetChargingCurrent(adapter: ChargingCurrentBinding): boolean {
  return (adapter.current.kind === 'capability' && adapter.current.writable) || adapter.supportsAppAction;
}

/**
 * Exact device-owned driver card, resolved from installed Homey metadata;
 * `undefined` when the cards do not list it.
 */
export function resolveChargingCurrentAction(
  adapter: ChargingCurrentBinding,
  cards: FlowActionCardIds,
  currentA: number,
): HomeyFlowAction | undefined {
  if (!Number.isInteger(currentA) || currentA < 6 || currentA > 32) throw new Error('Charging current must be 6–32 A.');
  if (!adapter.supportsAppAction) throw new Error('The device does not support built-in current actions.');
  return resolveDeviceActionCard(cards, adapter.appUri, {
    deviceId: adapter.deviceId, actionId: adapter.actionId, args: adapter.currentArguments(currentA),
  });
}

export function hasSharedChargingInstallation(
  adapter: ChargingCurrentBinding,
  devices: readonly HomeyDeviceLike[],
): boolean {
  const { scope } = adapter;
  return scope.kind === 'installation' && devices.some((device) => device.id !== adapter.deviceId
    && adapter.sharesInstallation(device));
}

/** Which chargers share one installation, as a support report lists them. */
export type ChargingInstallationGroup = {
  /** Numbers the installations in the order their first charger is listed, from 1. */
  group: number;
  /** How many listed chargers take their current from it. */
  chargers: number;
};

/**
 * The chargers among `devices` whose current is set for their installation,
 * each with the installation it shares. Installations are numbered rather than
 * named, so a report shows which chargers share one without the vendor's id.
 */
export function chargingInstallationGroups(
  devices: readonly HomeyDeviceLike[],
): ReadonlyMap<string, ChargingInstallationGroup> {
  const installationByDeviceId = new Map<string, string>();
  for (const device of devices) {
    const scope = resolveChargingCurrentAdapter(device)?.scope;
    if (scope?.kind === 'installation') installationByDeviceId.set(device.id, scope.installationId);
  }
  const numbers = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const installationId of installationByDeviceId.values()) {
    if (!numbers.has(installationId)) numbers.set(installationId, numbers.size + 1);
    counts.set(installationId, (counts.get(installationId) ?? 0) + 1);
  }
  return new Map([...installationByDeviceId].map(([deviceId, installationId]) => [deviceId, {
    group: numbers.get(installationId) ?? 0,
    chargers: counts.get(installationId) ?? 0,
  }]));
}
