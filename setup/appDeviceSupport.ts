import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { isBooleanMap, isModeDeviceTargets } from '../lib/utils/appTypeGuards';
import {
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  PRICE_OPTIMIZATION_SETTINGS,
} from '../lib/utils/settingsKeys';
import { AIRTREATMENT_SHED_FLOOR_C, NON_ONOFF_TEMPERATURE_SHED_FLOOR_C } from '../lib/utils/airtreatmentConstants';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../lib/utils/airtreatmentShedTemperature';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../lib/utils/targetCapabilities';

type StructuredEventEmitter = (event: Record<string, unknown>) => void;

type BooleanMap = Record<string, boolean>;
type PriceSettings = Record<string, { enabled?: boolean }>;
type OvershootBehaviorEntry = { action?: string; temperature?: number; stepId?: string };

function supportsTemperatureControl(device: TargetDeviceSnapshot): boolean {
  return device.deviceType === 'temperature';
}

function supportsPriceOnlyWithoutPower(device: TargetDeviceSnapshot): boolean {
  return device.powerCapable === false && supportsTemperatureControl(device);
}

function parseBooleanMap(value: unknown): BooleanMap {
  return isBooleanMap(value) ? value : {};
}

// Filter is active iff at least one device is explicitly opted-in (`true`).
// Explicit `false` keys (written by `disableUnsupportedDevices`) must NOT
// activate the filter on their own — otherwise a fresh-install user would
// flip from "all devices visible" to "only the explicit-true devices visible"
// the moment the first unsupported device is auto-disabled, silently dropping
// every implicitly-managed device from the runtime snapshot.
export function isManagedFilterActive(managedDevices: BooleanMap): boolean {
  return Object.values(managedDevices).some((value) => value === true);
}

// The SINGLE definition of "is this device in the runtime-planned set" — the
// set the plan cycle actually evaluates. The plan service builds its device
// list as `snapshot.map(toPlanDevice).filter(isRuntimePlannedDevice)` (see
// `createPlanService` in `appInit.ts`), so any consumer that needs to know
// whether a device will be planned (the create-smart-task candidate list AND
// create-time validation) MUST use this exact predicate. Otherwise a
// `managed: false` device can slip into the runtime snapshot when the managed
// filter is inactive (no device explicitly opted-in) yet be dropped by the
// planner — it would be offered/persisted but never planned or controlled.
//
// Encoded as `managed !== false` (not `managed === true`): an implicitly-managed
// device whose `managed` flag is `undefined`/absent (e.g. the managed-filter is
// inactive and the device was never explicitly toggled) IS planned, matching
// the planner's own filter. Only an explicit opt-out (`managed === false`) is
// excluded.
export function isRuntimePlannedDevice(device: { managed?: boolean }): boolean {
  return device.managed !== false;
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
  // Only demote IDs whose current value is explicitly `true`. An absent key
  // ("implicitly managed") and an explicit `false` are both treated as
  // unmanaged downstream, so writing `undefined → false` would change nothing
  // observably while still firing the settings handler — which then triggers
  // a recursive snapshot refresh on first boot. See appSnapshotHelpers.
  const idsToDemote = ids.filter((id) => current[id] === true);
  if (idsToDemote.length === 0) return false;
  const overrides = Object.fromEntries(idsToDemote.map((id) => [id, false] as const));
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
      currentTarget: getPrimaryTargetCapability(device.targets)?.value ?? null,
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
  debugStructured: StructuredEventEmitter;
}): void {
  const {
    unsupported,
    changedPriceOnly,
    managedChanged,
    controllableChanged,
    priceChanged,
    debugStructured,
  } = params;
  if (managedChanged || controllableChanged || priceChanged) {
    debugStructured({
      event: 'unsupported_controls_disabled',
      deviceIds: unsupported.map((device) => device.id),
      deviceNames: unsupported.map((device) => device.name),
    });
  }
  if (changedPriceOnly.length > 0) {
    debugStructured({
      event: 'price_only_support_enabled',
      deviceIds: changedPriceOnly.map((device) => device.id),
      deviceNames: changedPriceOnly.map((device) => device.name),
    });
  }
}

export function disableUnsupportedDevices(params: {
  snapshot: TargetDeviceSnapshot[];
  settings: Homey.App['homey']['settings'];
  debugStructured: StructuredEventEmitter;
}): void {
  const { snapshot, settings, debugStructured } = params;
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
  // Edge-trigger the price-only log: only emit when capacity was previously
  // enabled (`true`) and we're demoting it to `false`. Absent keys are not a
  // transition — they were already effectively unmanaged — so they must not
  // re-fire the log on every snapshot refresh. This matches the demotion
  // condition in `applyFalseOverrides`.
  const changedPriceOnly = priceOnly.filter((device) => controllable[device.id] === true);

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
      debugStructured,
    });
  }
  if (shedBehaviorUpdated > 0) {
    debugStructured({ event: 'temperature_shedding_enforced', deviceCount: shedBehaviorUpdated });
  }
}

type ModeTargetsBlob = Record<string, Record<string, number>>;
type SeedPlan = { device: TargetDeviceSnapshot; modes: string[]; value: number };

function parseModeDeviceTargets(value: unknown): ModeTargetsBlob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([mode, entries]) => {
      // Preserve the mode key even when its value is missing/null/primitive
      // — dropping it would silently delete a user-configured mode from the
      // blob on the next write. Coerce to an empty entry instead so the
      // mode survives and the seed pass can still populate it.
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return [mode, {} as Record<string, number>] as const;
      }
      const cleaned = Object.fromEntries(
        Object.entries(entries as Record<string, unknown>)
          .filter(([, raw]) => typeof raw === 'number' && Number.isFinite(raw)),
      ) as Record<string, number>;
      return [mode, cleaned] as const;
    }),
  );
}

// Per-process dedupe so a permanently-broken device (no finite setpoint)
// doesn't emit `mode_target_seed_skipped` on every snapshot refresh. Once a
// (device, mode, reason) tuple has been logged, we stay quiet until the app
// restarts — by which point the user has either fixed the device, removed
// it, or the operator has a fresh signal to act on.
const skipEmissionFingerprints = new Set<string>();
const skipFingerprint = (deviceId: string, mode: string, reason: string): string => (
  `${deviceId}::${mode}::${reason}`
);

// Per-process record of (deviceId, mode) entries we've already auto-seeded.
// Once an entry has been seeded, we don't re-seed it again in this process
// even if the user later clears it from the UI — otherwise the next snapshot
// refresh would race the user-clear and re-populate it. Persistence across
// restarts is intentionally not provided; if the entry is still missing on
// the next boot, seeding it again is the correct behaviour (and the user
// hasn't had a chance to clear it post-restart).
const seededEntryFingerprints = new Set<string>();
const seededEntryFingerprint = (deviceId: string, mode: string): string => (
  `${mode}::${deviceId}`
);

export function __resetSeedSkipDedupeForTests(): void {
  skipEmissionFingerprints.clear();
  seededEntryFingerprints.clear();
}

function resolveSeedValue(device: TargetDeviceSnapshot): number | null {
  const target = getPrimaryTargetCapability(device.targets);
  const current = target?.value;
  if (typeof current !== 'number' || !Number.isFinite(current)) return null;
  const normalized = normalizeTargetCapabilityValue({ target, value: current });
  return Number.isFinite(normalized) ? normalized : null;
}

function isSeedCandidate(
  device: TargetDeviceSnapshot,
  managed: BooleanMap,
  controllable: BooleanMap,
): boolean {
  if (!supportsTemperatureControl(device)) return false;
  if (getPrimaryTargetCapability(device.targets) === null) return false;
  if (managed[device.id] !== true) return false;
  if (controllable[device.id] !== true) return false;
  return true;
}

function findMissingModesForDevice(
  device: TargetDeviceSnapshot,
  existing: ModeTargetsBlob,
): string[] {
  return Object.keys(existing).filter((mode) => {
    // Edge-trigger: if we've already auto-seeded this (device, mode) once in
    // this process, never re-seed it — even if it's currently missing. A
    // user-clear from the settings UI must stick within the session;
    // otherwise the snapshot refresh races the clear and brings the value
    // back. On process restart we lose this memory, which is acceptable: if
    // the entry is still missing the user hasn't had a chance to clear it
    // post-restart, so re-seeding is the right call.
    if (seededEntryFingerprints.has(seededEntryFingerprint(device.id, mode))) return false;
    const value = existing[mode]?.[device.id];
    return !(typeof value === 'number' && Number.isFinite(value));
  });
}

function applySeedPlans(existing: ModeTargetsBlob, plans: SeedPlan[]): ModeTargetsBlob {
  return Object.fromEntries(
    Object.entries(existing).map(([mode, entries]) => {
      const additions = Object.fromEntries(
        plans
          .filter((plan) => plan.modes.includes(mode))
          .map((plan) => [plan.device.id, plan.value] as const),
      );
      return [mode, { ...entries, ...additions }];
    }),
  );
}

function emitSeedSkipped(
  plan: { device: TargetDeviceSnapshot; modes: string[] },
  reason: 'no_seed_source' | 'normalize_failed',
  structuredLog?: StructuredEventEmitter,
): void {
  plan.modes.forEach((mode) => {
    const fingerprint = skipFingerprint(plan.device.id, mode, reason);
    if (skipEmissionFingerprints.has(fingerprint)) return;
    skipEmissionFingerprints.add(fingerprint);
    structuredLog?.({
      event: 'mode_target_seed_skipped',
      deviceId: plan.device.id,
      deviceName: plan.device.name,
      mode,
      reason,
    });
  });
}

function buildSeedPlans(
  candidates: TargetDeviceSnapshot[],
  existing: ModeTargetsBlob,
  structuredLog?: StructuredEventEmitter,
): SeedPlan[] {
  return candidates.flatMap((device) => {
    const modes = findMissingModesForDevice(device, existing);
    if (modes.length === 0) return [];
    const value = resolveSeedValue(device);
    if (value === null) {
      emitSeedSkipped({ device, modes }, 'no_seed_source', structuredLog);
      return [];
    }
    return [{ device, modes, value }];
  });
}

export function seedMissingModeTargets(params: {
  snapshot: TargetDeviceSnapshot[];
  settings: Homey.App['homey']['settings'];
  structuredLog?: StructuredEventEmitter;
  debugStructured: StructuredEventEmitter;
}): void {
  const { snapshot, settings, structuredLog, debugStructured } = params;
  const existing = parseModeDeviceTargets(settings.get('mode_device_targets') as unknown);
  // No modes configured at all → nothing to seed against. A fresh install
  // with no operating mode is handled by the first UI write rather than
  // fabricating a mode here.
  if (!existing || Object.keys(existing).length === 0) return;

  const managed = parseBooleanMap(settings.get(MANAGED_DEVICES) as unknown);
  const controllable = parseBooleanMap(settings.get(CONTROLLABLE_DEVICES) as unknown);
  const candidates = snapshot.filter((device) => isSeedCandidate(device, managed, controllable));
  if (candidates.length === 0) return;

  const plans = buildSeedPlans(candidates, existing, structuredLog);
  if (plans.length === 0) return;

  const next = applySeedPlans(existing, plans);
  if (!isModeDeviceTargets(next)) {
    plans.forEach((plan) => emitSeedSkipped(plan, 'normalize_failed', structuredLog));
    return;
  }

  settings.set('mode_device_targets', next);
  plans.forEach((entry) => {
    entry.modes.forEach((mode) => {
      seededEntryFingerprints.add(seededEntryFingerprint(entry.device.id, mode));
    });
    structuredLog?.({
      event: 'mode_target_auto_seeded',
      deviceId: entry.device.id,
      deviceName: entry.device.name,
      seededModes: entry.modes,
      seededValue: entry.value,
      source: 'device_setpoint',
    });
  });
  debugStructured({
    event: 'mode_targets_seeded',
    deviceCount: plans.length,
    deviceIds: plans.map((entry) => entry.device.id),
    deviceNames: plans.map((entry) => entry.device.name),
  });
}
