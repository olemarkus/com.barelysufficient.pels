import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../utils/types';
import { isBooleanMap } from '../utils/appTypeGuards';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../utils/settingsKeys';

const AIRTREATMENT_SHED_FLOOR_C = 16;
const SHED_DEFAULT_DELTA_C = 3;
const SHED_STEP_C = 0.5;
const SHED_MIN_C = -20;
const SHED_MAX_C = 40;
const SHED_FALLBACK_TARGET_C = 20;

type PriceOptimizationEntry = { enabled?: boolean };
type OvershootBehaviorEntry = { action?: string; temperature?: number };
type BooleanMap = Record<string, boolean>;

function parseBooleanMap(value: unknown): BooleanMap {
  return isBooleanMap(value) ? value : {};
}

function parsePriceSettings(value: unknown): Record<string, PriceOptimizationEntry> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, PriceOptimizationEntry>;
}

function parseOvershootSettings(value: unknown): Record<string, OvershootBehaviorEntry> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, OvershootBehaviorEntry>;
}

function normalizeShedTemperature(value: number): number {
  const clamped = Math.max(SHED_MIN_C, Math.min(SHED_MAX_C, value));
  return Math.round(clamped / SHED_STEP_C) * SHED_STEP_C;
}

function isAirtreatmentTemperatureWithoutOnOff(device: TargetDeviceSnapshot): boolean {
  const classKey = (device.deviceClass || '').trim().toLowerCase();
  const hasTarget = Array.isArray(device.targets) && device.targets.length > 0;
  const hasOnOff = device.capabilities?.includes('onoff') === true;
  return classKey === 'airtreatment' && hasTarget && !hasOnOff;
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

function computeDefaultAirtreatmentShedTemperature(params: {
  settings: Homey.App['homey']['settings'];
  device: TargetDeviceSnapshot;
}): number {
  const modeTarget = readModeTarget({ settings: params.settings, deviceId: params.device.id });
  const currentTarget = params.device.targets?.[0]?.value;
  let baseTarget = SHED_FALLBACK_TARGET_C;
  if (modeTarget !== null) {
    baseTarget = modeTarget;
  } else if (typeof currentTarget === 'number') {
    baseTarget = currentTarget;
  }
  const candidate = Math.max(AIRTREATMENT_SHED_FLOOR_C, baseTarget - SHED_DEFAULT_DELTA_C);
  return normalizeShedTemperature(candidate);
}

function applyUnsupportedDeviceOverrides(params: {
  settings: Homey.App['homey']['settings'];
  unsupportedIds: string[];
  managed: BooleanMap;
  controllable: BooleanMap;
  priceSettings: Record<string, PriceOptimizationEntry> | null;
}): { managedChanged: boolean; controllableChanged: boolean; priceChanged: boolean } {
  const { settings, unsupportedIds, managed, controllable, priceSettings } = params;
  if (!unsupportedIds.length) {
    return { managedChanged: false, controllableChanged: false, priceChanged: false };
  }

  const falseOverrides = Object.fromEntries(unsupportedIds.map((id) => [id, false] as const));

  const managedChanged = unsupportedIds.some((id) => managed[id] !== false);
  if (managedChanged) {
    settings.set(MANAGED_DEVICES, { ...managed, ...falseOverrides });
  }

  const controllableChanged = unsupportedIds.some((id) => controllable[id] !== false);
  if (controllableChanged) {
    settings.set(CONTROLLABLE_DEVICES, { ...controllable, ...falseOverrides });
  }

  if (!priceSettings) {
    return { managedChanged, controllableChanged, priceChanged: false };
  }
  const priceUpdates = Object.fromEntries(
    unsupportedIds.flatMap((id) => {
      const entry = priceSettings[id];
      return entry?.enabled === true ? [[id, { ...entry, enabled: false }]] : [];
    }),
  );
  const priceChanged = Object.keys(priceUpdates).length > 0;
  if (priceChanged) {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { ...priceSettings, ...priceUpdates });
  }
  return { managedChanged, controllableChanged, priceChanged };
}

function resolveAirtreatmentOvershootUpdate(params: {
  settings: Homey.App['homey']['settings'];
  device: TargetDeviceSnapshot;
  existing: OvershootBehaviorEntry | undefined;
}): OvershootBehaviorEntry | null {
  const { settings, device, existing } = params;
  const existingTemp = typeof existing?.temperature === 'number' ? existing.temperature : null;

  let normalizedTemp = computeDefaultAirtreatmentShedTemperature({ settings, device });
  if (existingTemp !== null) {
    const normalizedExisting = normalizeShedTemperature(existingTemp);
    normalizedTemp = Math.max(AIRTREATMENT_SHED_FLOOR_C, normalizedExisting);
  }

  const needsUpdate = existing?.action !== 'set_temperature'
    || existingTemp === null
    || Math.abs(normalizedTemp - existingTemp) > 1e-9;
  if (!needsUpdate) return null;

  return { action: 'set_temperature', temperature: normalizedTemp };
}

function enforceAirtreatmentOvershootBehaviors(params: {
  settings: Homey.App['homey']['settings'];
  snapshot: TargetDeviceSnapshot[];
  managed: BooleanMap;
  controllable: BooleanMap;
  overshootSettings: Record<string, OvershootBehaviorEntry>;
}): number {
  const { settings, snapshot, managed, controllable, overshootSettings } = params;
  const updates = Object.fromEntries(snapshot.flatMap((device) => {
    if (device.powerCapable === false) return [];
    if (!isAirtreatmentTemperatureWithoutOnOff(device)) return [];
    if (managed[device.id] !== true || controllable[device.id] !== true) return [];

    const update = resolveAirtreatmentOvershootUpdate({
      settings,
      device,
      existing: overshootSettings[device.id],
    });
    return update ? [[device.id, update] as const] : [];
  }));

  const updated = Object.keys(updates).length;
  if (!updated) return 0;

  settings.set('overshoot_behaviors', { ...overshootSettings, ...updates });
  return updated;
}

export function disableUnsupportedDevices(params: {
  snapshot: TargetDeviceSnapshot[];
  settings: Homey.App['homey']['settings'];
  logDebug: (...args: unknown[]) => void;
}): void {
  const { snapshot, settings, logDebug } = params;
  const unsupported = snapshot.filter((device) => device.powerCapable === false);
  const unsupportedIds = unsupported.map((device) => device.id);

  const managed = parseBooleanMap(settings.get(MANAGED_DEVICES) as unknown);
  const controllable = parseBooleanMap(settings.get(CONTROLLABLE_DEVICES) as unknown);
  const priceSettings = parsePriceSettings(settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown);
  const overshootSettings = parseOvershootSettings(settings.get('overshoot_behaviors') as unknown);

  const { managedChanged, controllableChanged, priceChanged } = applyUnsupportedDeviceOverrides({
    settings,
    unsupportedIds,
    managed,
    controllable,
    priceSettings,
  });

  const shedBehaviorUpdated = enforceAirtreatmentOvershootBehaviors({
    settings,
    snapshot,
    managed,
    controllable,
    overshootSettings,
  });

  if (managedChanged || controllableChanged || priceChanged) {
    const names = unsupported.map((device) => device.name || device.id).join(', ');
    logDebug(`Disabled PELS controls for unsupported devices: ${names}`);
  }
  if (shedBehaviorUpdated > 0) {
    const suffix = shedBehaviorUpdated === 1 ? '' : 's';
    logDebug(`Enforced temperature shedding for ${shedBehaviorUpdated} air treatment device${suffix}`);
  }
}
