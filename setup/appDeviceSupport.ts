import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { isBooleanMap } from '../lib/utils/appTypeGuards';
import {
  MODE_DEVICE_TARGETS,
  MAIN_HOME_ID,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
  OVERSHOOT_BEHAVIORS,
  PRICE_OPTIMIZATION_SETTINGS,
  homeScopedSettingsKey,
  type HomeId,
} from '../lib/utils/settingsKeys';
import { getPrimaryTargetCapability, normalizeTargetCapabilityValue } from '../lib/utils/targetCapabilities';
import { isTemperaturePlanDevice } from '../lib/plan/planTemperatureDevice';
import type { UnrankedPlanInputDevice } from './appInit/toPlanDevice';
import {
  enforceTemperatureWithoutOnOffOvershootBehaviors,
  type OvershootBehaviorEntry,
  type ResolveOperatingModeForDevice,
} from './temperatureShedFloorDefaults';

export type { ResolveOperatingModeForDevice };
import { DEFAULT_MODE_NAME } from '../packages/shared-domain/src/modeLabels';
import {
  isWritableModeDeviceTargets,
  sanitizeModeDeviceTargets,
  type ModeDeviceTargets,
} from '../packages/shared-domain/src/settings/modeDeviceTargets';
import {
  resolveModeTargets,
  type ModeTargetDevice,
} from '../packages/shared-domain/src/modeCatalogResolution';

type StructuredEventEmitter = (event: Record<string, unknown>) => void;

type BooleanMap = Record<string, boolean>;
type PriceSettings = Record<string, { enabled?: boolean }>;

// Capability, not permission: "this device HAS a setpoint". Whether PELS may
// write it is a separate, later question (`projectTemperatureDeniedDevice`).
function hasTemperatureCapability(device: TargetDeviceSnapshot): boolean {
  return device.deviceType === 'temperature';
}

function supportsPriceOnlyWithoutPower(device: TargetDeviceSnapshot): boolean {
  return device.powerCapable === false && hasTemperatureCapability(device);
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
  /**
   * Per-device active-mode resolution for the overshoot default seed (a
   * sub-home member's default must follow ITS home's mode, and an `unavailable`
   * outcome skips the seed instead of writing one under the global mode).
   * Absent (tests, legacy callers) = the historical raw global-mode read.
   */
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): void {
  const { snapshot, settings, debugStructured, resolveOperatingModeForDevice } = params;
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
    resolveOperatingModeForDevice,
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

/**
 * Persist the per-mode targets `resolveModeTargets` had to fill.
 *
 * The resolver already answers completely, so nothing downstream depends on
 * this pass having run — a device that appeared a second ago is planned with a
 * resolved target either way. What this adds is durability: PELS owns a managed
 * thermostat's setpoint, and a setpoint that is re-derived from the device on
 * every boot is not owned, it is followed. Writing the first resolution down
 * makes it the owner's target from then on, editable on the Modes screen and
 * stable across a restart.
 *
 * Runs on the snapshot refresh, before the plan cycle, so the write is a
 * deliberate act on the producer's pass rather than a side effect hiding inside
 * a plan build.
 *
 * Takes PLAN devices, not the snapshot the settings UI reads. The question here
 * — "what setpoint does PELS hold this device at" — is a control question, and
 * the two views answer differently on purpose: a device whose owner switched
 * temperature control off is still a temperature device to the UI (that is what
 * renders the toggle and the saved targets beneath it) and is NOT one to
 * control. Consuming the planner's type is what keeps this pass from having a
 * concept of the flag at all.
 */
export function persistFilledModeTargets(params: {
  devices: readonly UnrankedPlanInputDevice[];
  settings: Homey.App['homey']['settings'];
  resolveHomeIdForDevice?: (deviceId: string) => HomeId | null;
  structuredLog?: StructuredEventEmitter;
  debugStructured: StructuredEventEmitter;
}): void {
  const {
    devices: planDevices, settings, resolveHomeIdForDevice, structuredLog, debugStructured,
  } = params;
  const managed = parseBooleanMap(settings.get(MANAGED_DEVICES) as unknown);
  const candidates = planDevices.filter((device) => isRuntimePlannedDevice({ managed: managed[device.id] }));
  if (candidates.length === 0) return;

  const byHome = new Map<HomeId, UnrankedPlanInputDevice[]>();
  candidates.forEach((device) => {
    const homeId = resolveHomeIdForDevice ? resolveHomeIdForDevice(device.id) : MAIN_HOME_ID;
    if (homeId === null) return;
    byHome.set(homeId, [...(byHome.get(homeId) ?? []), device]);
  });

  const writes = [...byHome].flatMap(([homeId, devices]) => {
    const key = homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId);
    const read = readModeTargetsCatalog(settings, key);
    // Read failed, or the payload is not something this code recognizes: decide
    // nothing, retry next refresh, and never write over it.
    if (read.state === 'unavailable') return [];
    const probes = devices.flatMap(buildModeTargetProbe);
    // Every mode the home has, so switching modes never lands on a blank. A
    // home whose catalog has never been written starts at the default mode —
    // Main's blob is only ever written by the settings UI, so an owner who
    // never opened the Modes screen had none at all while PELS planned, shed,
    // and auto-assigned a `set_temperature` shed to their heaters.
    const modes = Object.keys(read.catalog).length === 0
      ? [DEFAULT_MODE_NAME]
      : Object.keys(read.catalog);
    const filled = modes.flatMap((mode) => {
      const resolved = resolveModeTargets({
        targetCFor: (deviceId) => read.catalog[mode]?.[deviceId],
        devices: probes,
      });
      return Object.entries(resolved.unstoredTargetsByDeviceId)
        // Once filled in this process, never re-fill: otherwise this pass would
        // race a user-clear on the Modes screen and bring the value back.
        .filter(([deviceId]) => !alreadyFilled(homeId, mode, deviceId))
        .map(([deviceId, targetC]) => ({ mode, deviceId, targetC }));
    });
    if (filled.length === 0) return [];
    const next: ModeDeviceTargets = Object.fromEntries([
      ...Object.entries(read.catalog),
      ...modes.map((mode) => [mode, {
        ...(read.catalog[mode] ?? {}),
        ...Object.fromEntries(filled.filter((f) => f.mode === mode).map((f) => [f.deviceId, f.targetC])),
      }] as const),
    ]);
    return [{ homeId, key, next, filled }];
  });
  if (writes.length === 0) return;
  if (writes.some((write) => !isWritableModeDeviceTargets(write.next))) return;

  writes.forEach((write) => {
    settings.set(write.key, write.next);
    write.filled.forEach((entry) => {
      filledEntryFingerprints.add(filledEntryFingerprint(write.homeId, entry.mode, entry.deviceId));
    });
    // One line per device, naming the modes it was filled for — a device joining
    // five modes is one fact, not five.
    [...new Set(write.filled.map((entry) => entry.deviceId))].forEach((deviceId) => {
      const entries = write.filled.filter((entry) => entry.deviceId === deviceId);
      structuredLog?.({
        event: 'mode_target_filled',
        deviceId,
        deviceName: planDevices.find((device) => device.id === deviceId)?.name,
        filledModes: entries.map((entry) => entry.mode),
        targetC: entries[0]?.targetC,
      });
    });
  });
  debugStructured({
    event: 'mode_targets_persisted',
    entryCount: writes.reduce((sum, write) => sum + write.filled.length, 0),
  });
}

/**
 * One device's facts for the resolver, or nothing if it has no setpoint to be
 * told.
 *
 * `isTemperaturePlanDevice` is the whole test — the same one the planner uses —
 * and it already answers correctly for BOTH reasons a device might have none: no
 * `target_temperature` capability, or an owner who switched temperature control
 * off, which `toPlanDevice` resolved away before this pass ever saw the device.
 *
 * The setpoint is normalized to the device's own min/max/step, so what gets
 * persisted is a value the device can actually hold.
 */
function buildModeTargetProbe(device: UnrankedPlanInputDevice): ModeTargetDevice[] {
  if (!isTemperaturePlanDevice(device)) return [];
  const normalized = normalizeTargetCapabilityValue({
    target: getPrimaryTargetCapability(device.targets),
    value: device.currentTarget,
  });
  // Guaranteed finite by the observer's atomic temperature facet, so the only
  // way this fails is a capability whose bounds cannot hold the reading.
  if (!Number.isFinite(normalized)) return [];
  return [{ id: device.id, heldSetpointC: normalized }];
}



// Per-process record of (home, mode, device) entries this process has already
// filled. Once filled, never re-fill in this process even if the entry goes
// missing again — otherwise a snapshot refresh would race a user-clear from the
// settings UI and bring the value straight back. Deliberately not persisted: if
// the entry is still missing after a restart, the owner has not had a chance to
// clear it, so filling again is the right call.
const filledEntryFingerprints = new Set<string>();
const filledEntryFingerprint = (homeId: HomeId, mode: string, deviceId: string): string =>
  `${homeId}::${mode}::${deviceId}`;
const alreadyFilled = (homeId: HomeId, mode: string, deviceId: string): boolean =>
  filledEntryFingerprints.has(filledEntryFingerprint(homeId, mode, deviceId));

export function __resetModeTargetFillDedupeForTests(): void {
  filledEntryFingerprints.clear();
}

type ModeTargetsCatalogRead =
  | { state: 'resolved'; catalog: ModeDeviceTargets }
  | { state: 'unavailable' };

/**
 * The mode-target catalog for one home, with genuine absence separated from a
 * failed read. Only a key the store demonstrably never held resolves to an
 * EMPTY catalog — the one state this pass may build a default mode on top of.
 * A thrown read, an unusable key list, a payload the parser does not recognize,
 * or a present-but-null key all answer `unavailable`, because the next act is a
 * whole-blob `set` and one transient SDK miss must not become a wipe
 * (`notes/persisted-settings-state.md`).
 *
 * The SDK answers an unwritten setting with `null` on Homey Pro and the
 * Self-Hosted Server, and object doubles in specs answer `undefined`; the key
 * list is the authority for absence in both cases (`setup/AGENTS.md`).
 */
function readModeTargetsCatalog(
  settings: Homey.App['homey']['settings'],
  key: string,
): ModeTargetsCatalogRead {
  let raw: unknown;
  try {
    raw = settings.get(key) as unknown;
  } catch {
    return { state: 'unavailable' };
  }
  const parsed = sanitizeModeDeviceTargets(raw);
  if (parsed !== null) return { state: 'resolved', catalog: parsed };
  if (raw !== undefined && raw !== null) return { state: 'unavailable' };
  let keys: unknown;
  try {
    keys = settings.getKeys() as unknown;
  } catch {
    return { state: 'unavailable' };
  }
  // An EMPTY key list is itself a suspect read — a real install always has keys.
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((entry) => typeof entry === 'string')) {
    return { state: 'unavailable' };
  }
  return keys.includes(key) ? { state: 'unavailable' } : { state: 'resolved', catalog: {} };
}

