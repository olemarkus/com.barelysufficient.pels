import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../utils/types';
import { isBooleanMap } from '../utils/appTypeGuards';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../utils/settingsKeys';
import { AIRTREATMENT_SHED_FLOOR_C, NON_ONOFF_TEMPERATURE_SHED_FLOOR_C } from '../utils/airtreatmentConstants';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../utils/airtreatmentShedTemperature';

type BooleanMap = Record<string, boolean>;
type PriceSettings = Record<string, { enabled?: boolean }>;
type OvershootBehaviorEntry = { action?: string; temperature?: number };

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

function parseOvershootSettings(value: unknown): Record<string, OvershootBehaviorEntry> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, OvershootBehaviorEntry>;
}

function isTemperatureWithoutOnOff(device: TargetDeviceSnapshot): boolean {
  const hasTarget = Array.isArray(device.targets) && device.targets.length > 0;
  const hasOnOff = device.capabilities?.includes('onoff') === true;
  return supportsTemperatureControl(device) && hasTarget && !hasOnOff;
}

function resolveTemperatureShedFloor(device: TargetDeviceSnapshot): number {
  const classKey = (device.deviceClass || '').trim().toLowerCase();
  return classKey === 'airtreatment' ? AIRTREATMENT_SHED_FLOOR_C : NON_ONOFF_TEMPERATURE_SHED_FLOOR_C;
}

function readModeTarget(params: {
  settings: Homey.App['homey']['settings'];
  deviceId: string;
}): number | null {
  const modeTargetsRaw = params.settings.get('mode_device_targets') as unknown;
  const operatingModeRaw = params.settings.get(OPERATING_MODE_SETTING) as unknown;
  if (!modeTargetsRaw || typeof modeTargetsRaw !== 'object') return null;
  if (typeof operatingModeRaw !== 'string' || !operatingModeRaw.trim()) return null;

  const modeTargets = modeTargetsRaw as Record<string, Record<string, unknown>>;
  const modeMap = modeTargets[operatingModeRaw];
  if (!modeMap || typeof modeMap !== 'object') return null;
  const value = modeMap[params.deviceId];
  return Number.isFinite(value) ? Number(value) : null;
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

function resolveTemperatureWithoutOnOffOvershootUpdate(params: {
  settings: Homey.App['homey']['settings'];
  device: TargetDeviceSnapshot;
  existing: OvershootBehaviorEntry | undefined;
}): OvershootBehaviorEntry | null {
  const { settings, device, existing } = params;
  const existingTemp = typeof existing?.temperature === 'number' ? existing.temperature : null;
  const minFloorC = resolveTemperatureShedFloor(device);

  let normalizedTemp: number;
  if (existingTemp !== null) {
    const normalizedExisting = normalizeShedTemperature(existingTemp);
    normalizedTemp = Math.max(minFloorC, normalizedExisting);
  } else {
    normalizedTemp = computeDefaultAirtreatmentShedTemperature({
      modeTarget: readModeTarget({ settings, deviceId: device.id }),
      currentTarget: typeof device.targets?.[0]?.value === 'number' ? device.targets[0].value : null,
      minFloorC,
    });
  }

  const needsUpdate = existing?.action !== 'set_temperature'
    || existingTemp === null
    || Math.abs(normalizedTemp - existingTemp) > 1e-9;
  if (!needsUpdate) return null;

  return { action: 'set_temperature', temperature: normalizedTemp };
}

function enforceTemperatureWithoutOnOffOvershootBehaviors(params: {
  settings: Homey.App['homey']['settings'];
  snapshot: TargetDeviceSnapshot[];
  managed: BooleanMap;
  controllable: BooleanMap;
  overshootSettings: Record<string, OvershootBehaviorEntry>;
}): number {
  const { settings, snapshot, managed, controllable, overshootSettings } = params;
  const updates = Object.fromEntries(snapshot.flatMap((device) => {
    if (device.powerCapable === false) return [];
    if (!isTemperatureWithoutOnOff(device)) return [];
    if (managed[device.id] !== true || controllable[device.id] !== true) return [];

    const update = resolveTemperatureWithoutOnOffOvershootUpdate({
      settings,
      device,
      existing: overshootSettings[device.id],
    });
    return update ? [[device.id, update] as const] : [];
  }));

  const updated = Object.keys(updates).length;
  if (!updated) return 0;

  settings.set(OVERSHOOT_BEHAVIORS, { ...overshootSettings, ...updates });
  return updated;
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

  const managed = parseBooleanMap(settings.get(MANAGED_DEVICES) as unknown);
  const controllable = parseBooleanMap(settings.get(CONTROLLABLE_DEVICES) as unknown);
  const priceSettings = parsePriceSettings(settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown);
  const overshootSettings = parseOvershootSettings(settings.get(OVERSHOOT_BEHAVIORS) as unknown);
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

  const shedBehaviorUpdated = enforceTemperatureWithoutOnOffOvershootBehaviors({
    settings,
    snapshot,
    managed,
    controllable,
    overshootSettings,
  });

  if (unsupported.length > 0) {
    logUnsupportedChanges({
      unsupported,
      changedPriceOnly,
      managedChanged,
      controllableChanged,
      priceChanged,
      logDebug,
    });
  }
  if (shedBehaviorUpdated > 0) {
    const suffix = shedBehaviorUpdated === 1 ? '' : 's';
    logDebug(`Enforced temperature shedding for ${shedBehaviorUpdated} non-onoff temperature device${suffix}`);
  }
}
