import type { HomeyDeviceLike } from '../utils/types';
import type { ChargingCurrentAction } from './transport/chargingAccess';

/** A resolved command binding, separate from the charger's binary switch. */
export type ChargingCurrentAdapter = {
  deviceId: string;
  currentCapabilityId: string;
  currentWritable: boolean;
  actionId: string;
  appUri: string;
  scope: { kind: 'vehicle' } | { kind: 'installation'; installationId: string };
};

export function isTeslaChargingDevice(device: HomeyDeviceLike): boolean {
  return device.driverId === 'homey:app:com.tesla.car:battery'
    && ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level']
      .every((capability) => device.capabilities?.includes(capability));
}

export function resolveChargingCurrentAdapter(device: HomeyDeviceLike): ChargingCurrentAdapter | undefined {
  if (isTeslaChargingDevice(device)) {
    return {
      deviceId: device.id, currentCapabilityId: 'measure_charge_current_max',
      currentWritable: device.capabilitiesObj?.measure_charge_current_max?.setable === true,
      actionId: 'charge_current', appUri: 'homey:app:com.tesla.car', scope: { kind: 'vehicle' },
    };
  }
  const match = /^homey:app:com\.zaptec:(go|go2|home|pro)$/u.exec(device.driverId ?? '');
  const installationId = device.data?.installationId;
  if (!match || !installationId || !device.capabilities?.includes('available_installation_current')) return undefined;
  return {
    deviceId: device.id, currentCapabilityId: 'available_installation_current',
    currentWritable: device.capabilitiesObj?.available_installation_current?.setable === true,
    appUri: 'homey:app:com.zaptec',
    actionId: match[1] === 'go' ? 'installation_current_control' : `${match[1]}_installation_current_control`,
    scope: { kind: 'installation', installationId },
  };
}

/** Exact device-owned driver card, resolved from installed Homey metadata. */
export function resolveChargingCurrentAction(
  adapter: ChargingCurrentAdapter,
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
    args: adapter.scope.kind === 'vehicle'
      ? { current: currentA }
      : { current1: currentA, current2: currentA, current3: currentA },
  };
  const appCardId = `${adapter.appUri}:${adapter.actionId}`;
  const appCard = cards.find((entry) => typeof entry === 'object' && entry !== null
    && 'id' in entry && entry.id === appCardId);
  if (!appCard) throw new Error('The charging-current action is unavailable in Homey.');
  return {
    ownerUri: adapter.appUri, cardId: appCardId,
    args: adapter.scope.kind === 'vehicle'
      ? { device: { id: adapter.deviceId }, current: currentA }
      : { device: { id: adapter.deviceId }, current1: currentA, current2: currentA, current3: currentA },
  };
}

export function hasSharedChargingInstallation(
  adapter: ChargingCurrentAdapter,
  devices: readonly HomeyDeviceLike[],
): boolean {
  const { scope } = adapter;
  return scope.kind === 'installation' && devices.some((device) => device.id !== adapter.deviceId
    && device.driverId?.startsWith('homey:app:com.zaptec:')
    && device.data?.installationId === scope.installationId);
}

function actionCards(inventory: unknown): unknown[] {
  if (Array.isArray(inventory)) return inventory;
  if (typeof inventory === 'object' && inventory !== null) return Object.values(inventory);
  return [];
}
