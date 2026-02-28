import type Homey from 'homey';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES, PRICE_OPTIMIZATION_SETTINGS } from '../utils/settingsKeys';
import { isBooleanMap } from '../utils/appTypeGuards';

type MigrateManagedDevicesParams = {
  homey: Homey.App['homey'];
  log: (message: string) => void;
};

const buildTrueMap = (deviceIds: Iterable<string>): Record<string, boolean> => (
  Object.fromEntries(Array.from(deviceIds, (deviceId) => [deviceId, true])) as Record<string, boolean>
);

export const migrateManagedDevices = (params: MigrateManagedDevicesParams): void => {
  const { homey, log } = params;
  const managedRaw = homey.settings.get(MANAGED_DEVICES) as unknown;
  const controllableRaw = homey.settings.get(CONTROLLABLE_DEVICES) as unknown;
  const priceRaw = homey.settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown;
  const managed = isBooleanMap(managedRaw) ? { ...managedRaw } : {};
  const controllable = isBooleanMap(controllableRaw) ? { ...controllableRaw } : {};
  const priceEnabled = new Set<string>();

  if (priceRaw && typeof priceRaw === 'object') {
    Object.entries(priceRaw as Record<string, unknown>).forEach(([deviceId, entry]) => {
      if (entry && typeof entry === 'object' && (entry as { enabled?: unknown }).enabled === true) {
        priceEnabled.add(deviceId);
      }
    });
  }

  const managedDeviceIds = new Set<string>([
    ...Array.from(priceEnabled).filter((deviceId) => !Object.prototype.hasOwnProperty.call(managed, deviceId)),
    ...Object.entries(controllable)
      .filter(([deviceId, isControllable]) => (
        isControllable === true && !Object.prototype.hasOwnProperty.call(managed, deviceId)
      ))
      .map(([deviceId]) => deviceId),
  ]);
  const managedChanged = managedDeviceIds.size > 0;
  const nextManaged = managedChanged
    ? {
      ...managed,
      ...buildTrueMap(managedDeviceIds),
    }
    : managed;

  const controllableDeviceIds = Object.entries(nextManaged)
    .filter(([, isManaged]) => isManaged === true)
    .map(([deviceId]) => deviceId)
    .filter((deviceId) => {
    const hasCapacity = typeof controllable[deviceId] === 'boolean';
    const hasPrice = priceEnabled.has(deviceId);
      return !hasCapacity && !hasPrice;
    });
  const controllableChanged = controllableDeviceIds.length > 0;
  const nextControllable = controllableChanged
    ? {
      ...controllable,
      ...buildTrueMap(controllableDeviceIds),
    }
    : controllable;

  if (managedChanged) {
    homey.settings.set(MANAGED_DEVICES, nextManaged);
  }
  if (controllableChanged) {
    homey.settings.set(CONTROLLABLE_DEVICES, nextControllable);
  }
  if (managedChanged || controllableChanged) {
    log('Migrated managed device settings to explicit managed devices.');
  }
};
