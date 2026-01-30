import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../utils/types';
import { isBooleanMap } from '../utils/appTypeGuards';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES, PRICE_OPTIMIZATION_SETTINGS } from '../utils/settingsKeys';

export function disableUnsupportedDevices(params: {
  snapshot: TargetDeviceSnapshot[];
  settings: Homey.App['homey']['settings'];
  logDebug: (...args: unknown[]) => void;
}): void {
  const { snapshot, settings, logDebug } = params;
  const unsupported = snapshot.filter((device) => device.powerCapable === false);
  if (!unsupported.length) return;

  const managedRaw = settings.get(MANAGED_DEVICES) as unknown;
  const controllableRaw = settings.get(CONTROLLABLE_DEVICES) as unknown;
  const priceRaw = settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown;

  const unsupportedIds = unsupported.map((device) => device.id);

  const managed = isBooleanMap(managedRaw) ? managedRaw : {};
  const controllable = isBooleanMap(controllableRaw) ? controllableRaw : {};

  const managedChanged = unsupportedIds.some((id) => managed[id] !== false);
  const controllableChanged = unsupportedIds.some((id) => controllable[id] !== false);

  if (managedChanged) {
    const nextManaged = unsupportedIds.reduce<Record<string, boolean>>((acc, id) => (
      acc[id] === false ? acc : { ...acc, [id]: false }
    ), managed);
    settings.set(MANAGED_DEVICES, nextManaged);
  }
  if (controllableChanged) {
    const nextControllable = unsupportedIds.reduce<Record<string, boolean>>((acc, id) => (
      acc[id] === false ? acc : { ...acc, [id]: false }
    ), controllable);
    settings.set(CONTROLLABLE_DEVICES, nextControllable);
  }

  const priceSettings = priceRaw && typeof priceRaw === 'object'
    ? priceRaw as Record<string, { enabled?: boolean }>
    : null;
  const priceChanged = Boolean(priceSettings) && unsupportedIds.some((id) => priceSettings?.[id]?.enabled === true);
  if (priceSettings && priceChanged) {
    const nextPriceSettings = unsupportedIds.reduce<Record<string, { enabled?: boolean }>>((acc, id) => {
      const entry = acc[id];
      if (!entry || entry.enabled !== true) return acc;
      return { ...acc, [id]: { ...entry, enabled: false } };
    }, priceSettings);
    settings.set(PRICE_OPTIMIZATION_SETTINGS, nextPriceSettings);
  }

  if (managedChanged || controllableChanged || priceChanged) {
    const names = unsupported.map((device) => device.name || device.id).join(', ');
    logDebug(`Disabled PELS controls for unsupported devices: ${names}`);
  }
}
