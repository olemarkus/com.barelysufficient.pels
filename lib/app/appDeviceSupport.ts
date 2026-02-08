import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../utils/types';
import { isBooleanMap } from '../utils/appTypeGuards';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES, PRICE_OPTIMIZATION_SETTINGS } from '../utils/settingsKeys';

type BooleanMap = Record<string, boolean>;
type PriceSettings = Record<string, { enabled?: boolean }>;

function supportsTemperatureControl(device: TargetDeviceSnapshot): boolean {
  return device.deviceType === 'temperature';
}

function supportsPriceOnlyWithoutPower(device: TargetDeviceSnapshot): boolean {
  return device.powerCapable === false && supportsTemperatureControl(device);
}

function parseBooleanMap(value: unknown): BooleanMap {
  return isBooleanMap(value) ? value : {};
}

function parsePriceSettings(value: unknown): PriceSettings | null {
  return value && typeof value === 'object' ? value as PriceSettings : null;
}

function applyFalseOverrides(params: {
  settings: Homey.App['homey']['settings'];
  key: string;
  current: BooleanMap;
  ids: string[];
}): boolean {
  const { settings, key, current, ids } = params;
  const changed = ids.some((id) => current[id] !== false);
  if (!changed) return false;
  const overrides = Object.fromEntries(ids.map((id) => [id, false] as const));
  settings.set(key, { ...current, ...overrides });
  return true;
}

function buildPriceDisableUpdates(priceSettings: PriceSettings, ids: string[]): PriceSettings {
  return Object.fromEntries(ids.flatMap((id) => {
    const entry = priceSettings[id];
    return entry?.enabled === true ? [[id, { ...entry, enabled: false }]] : [];
  }));
}

function applyPriceDisableOverrides(params: {
  settings: Homey.App['homey']['settings'];
  priceSettings: PriceSettings | null;
  ids: string[];
}): boolean {
  const { settings, priceSettings, ids } = params;
  if (!priceSettings) return false;
  const updates = buildPriceDisableUpdates(priceSettings, ids);
  const changed = Object.keys(updates).length > 0;
  if (!changed) return false;
  settings.set(PRICE_OPTIMIZATION_SETTINGS, { ...priceSettings, ...updates });
  return true;
}

function getUnsupportedBuckets(snapshot: TargetDeviceSnapshot[]): {
  unsupported: TargetDeviceSnapshot[];
  fullyUnsupportedIds: string[];
  unsupportedIds: string[];
  priceOnly: TargetDeviceSnapshot[];
} {
  const unsupported = snapshot.filter((device) => device.powerCapable === false);
  const withPriceOnlyFlag = unsupported.map((device) => ({
    device,
    id: device.id,
    isPriceOnly: supportsPriceOnlyWithoutPower(device),
  }));

  return {
    unsupported,
    unsupportedIds: withPriceOnlyFlag.map((entry) => entry.id),
    fullyUnsupportedIds: withPriceOnlyFlag
      .filter((entry) => !entry.isPriceOnly)
      .map((entry) => entry.id),
    priceOnly: withPriceOnlyFlag
      .filter((entry) => entry.isPriceOnly)
      .map((entry) => entry.device),
  };
}

function logUnsupportedChanges(params: {
  unsupported: TargetDeviceSnapshot[];
  changedPriceOnly: TargetDeviceSnapshot[];
  managedChanged: boolean;
  controllableChanged: boolean;
  priceChanged: boolean;
  logDebug: (...args: unknown[]) => void;
}): void {
  const {
    unsupported,
    changedPriceOnly,
    managedChanged,
    controllableChanged,
    priceChanged,
    logDebug,
  } = params;
  if (managedChanged || controllableChanged || priceChanged) {
    const names = unsupported.map((device) => device.name || device.id).join(', ');
    logDebug(`Disabled unsupported PELS controls: ${names}`);
  }
  if (changedPriceOnly.length > 0) {
    const names = changedPriceOnly.map((device) => device.name || device.id).join(', ');
    logDebug(`Price-only support enabled (capacity disabled) for no-power temperature devices: ${names}`);
  }
}

export function disableUnsupportedDevices(params: {
  snapshot: TargetDeviceSnapshot[];
  settings: Homey.App['homey']['settings'];
  logDebug: (...args: unknown[]) => void;
}): void {
  const { snapshot, settings, logDebug } = params;
  const {
    unsupported,
    unsupportedIds,
    fullyUnsupportedIds,
    priceOnly,
  } = getUnsupportedBuckets(snapshot);
  if (!unsupported.length) return;

  const managed = parseBooleanMap(settings.get(MANAGED_DEVICES) as unknown);
  const controllable = parseBooleanMap(settings.get(CONTROLLABLE_DEVICES) as unknown);
  const priceSettings = parsePriceSettings(settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown);
  const changedPriceOnly = priceOnly.filter((device) => controllable[device.id] !== false);

  const managedChanged = applyFalseOverrides({
    settings,
    key: MANAGED_DEVICES,
    current: managed,
    ids: fullyUnsupportedIds,
  });
  const controllableChanged = applyFalseOverrides({
    settings,
    key: CONTROLLABLE_DEVICES,
    current: controllable,
    ids: unsupportedIds,
  });
  const priceChanged = applyPriceDisableOverrides({
    settings,
    priceSettings,
    ids: fullyUnsupportedIds,
  });

  logUnsupportedChanges({
    unsupported,
    changedPriceOnly,
    managedChanged,
    controllableChanged,
    priceChanged,
    logDebug,
  });
}
