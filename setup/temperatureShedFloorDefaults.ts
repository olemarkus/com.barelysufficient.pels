/**
 * Shed-floor defaults for temperature devices with no on/off axis.
 *
 * A device PELS can only lower (no `onoff`) still has to be sheddable, so the
 * app assigns it a `set_temperature` shed behaviour without asking, and derives
 * the floor from the device's own mode target / setpoint. Split out of
 * `appDeviceSupport.ts`, which owns the unsupported-device demotions that call
 * this.
 */
import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { DeviceOperatingModeOutcome } from './homeRuntime/homeOperatingMode';
import { isTemperatureControlDevice } from '../packages/shared-domain/src/temperatureDeviceKind';
import {
  MODE_DEVICE_TARGETS,
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
  homeScopedSettingsKey,
} from '../lib/utils/settingsKeys';
import {
  AIRTREATMENT_SHED_FLOOR_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
} from '../packages/shared-domain/src/utils/airtreatmentConstants';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../packages/shared-domain/src/utils/airtreatmentShedTemperature';
import { getPrimaryTargetCapability } from '../lib/utils/targetCapabilities';
import { sanitizeModeDeviceTargets } from '../packages/shared-domain/src/settings/modeDeviceTargets';

/**
 * Per-device active-mode resolution, carrying the producer's read-outcome
 * discriminant. Consumers that PERSIST a mode-derived value must skip on
 * `unavailable` rather than substitute a mode of their own.
 */
export type ResolveOperatingModeForDevice = (deviceId: string) => DeviceOperatingModeOutcome;

export type OvershootBehaviorEntry = { action?: string; temperature?: number; stepId?: string };

type BooleanMap = Record<string, boolean>;

function isTemperatureWithoutOnOff(device: TargetDeviceSnapshot): boolean {
  const hasTarget = Array.isArray(device.targets) && device.targets.length > 0;
  const hasOnOff = device.capabilities?.includes('onoff') === true;
  return isTemperatureControlDevice(device) && hasTarget && !hasOnOff;
}

function resolveTemperatureShedFloor(device: TargetDeviceSnapshot): number {
  const classKey = (device.deviceClass || '').trim().toLowerCase();
  return classKey === 'airtreatment' ? AIRTREATMENT_SHED_FLOOR_C : NON_ONOFF_TEMPERATURE_SHED_FLOOR_C;
}

/**
 * The active mode governing one device's mode target. Default: the historical
 * raw unsuffixed read (main-home behaviour). The app wires
 * `resolveOperatingModeForDevice` (setup/homeRuntime/homeOperatingMode.ts) so
 * a sub-home member resolves through ITS home's effective mode instead of
 * silently using the global one.
 */
function resolveModeForDeviceTarget(params: {
  settings: Homey.App['homey']['settings'];
  deviceId: string;
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): DeviceOperatingModeOutcome {
  if (params.resolveOperatingModeForDevice) {
    return params.resolveOperatingModeForDevice(params.deviceId);
  }
  const operatingModeRaw = params.settings.get(OPERATING_MODE_SETTING) as unknown;
  return {
    state: 'resolved',
    mode: typeof operatingModeRaw === 'string' && operatingModeRaw.trim() ? operatingModeRaw : null,
    homeId: MAIN_HOME_ID,
    catalogHomeId: MAIN_HOME_ID,
  };
}

/**
 * `unavailable` is NOT "no target configured": either the owning home's active
 * mode or the mode-targets blob needed to resolve that mode is unknown. It is
 * kept distinct all the way to the seed decision because the two demand
 * opposite handling — absent DEVICE target = fall back to the device setpoint,
 * unavailable mode evidence = write nothing.
 */
type ModeTargetRead =
  | { state: 'resolved'; modeTarget: number | null }
  | { state: 'unavailable' };

function readModeTarget(params: {
  settings: Homey.App['homey']['settings'];
  deviceId: string;
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): ModeTargetRead {
  const operatingMode = resolveModeForDeviceTarget(params);
  if (operatingMode.state === 'unavailable') return { state: 'unavailable' };
  if (operatingMode.mode === null) return { state: 'resolved', modeTarget: null };

  let modeTargetsRaw: unknown;
  try {
    modeTargetsRaw = params.settings.get(
      homeScopedSettingsKey(MODE_DEVICE_TARGETS, operatingMode.catalogHomeId),
    ) as unknown;
  } catch {
    return { state: 'unavailable' };
  }
  // Through the key's owner: this used to parse the same bytes itself and read
  // a malformed mode as `unavailable`, where the owner reads it as an empty
  // mode. That is the third policy for one key this PR exists to remove — it
  // made a device skip its overshoot seed instead of treating the target as
  // absent (`notes/settings-key-ownership.md`).
  const modeTargets = sanitizeModeDeviceTargets(modeTargetsRaw);
  if (modeTargets === null) return { state: 'unavailable' };
  const value = modeTargets[operatingMode.mode]?.[params.deviceId];
  return { state: 'resolved', modeTarget: value === undefined ? null : value };
}

function resolveTemperatureWithoutOnOffOvershootUpdate(params: {
  settings: Homey.App['homey']['settings'];
  device: TargetDeviceSnapshot;
  existing: OvershootBehaviorEntry | undefined;
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): OvershootBehaviorEntry | null {
  const { settings, device, existing, resolveOperatingModeForDevice } = params;
  const existingTemp = typeof existing?.temperature === 'number' ? existing.temperature : null;
  const minFloorC = resolveTemperatureShedFloor(device);

  let normalizedTemp: number;
  if (existingTemp !== null) {
    const normalizedExisting = normalizeShedTemperature(existingTemp);
    normalizedTemp = Math.max(minFloorC, normalizedExisting);
  } else {
    const modeTargetRead = readModeTarget({
      settings,
      deviceId: device.id,
      resolveOperatingModeForDevice,
    });
    // The owning home's active mode is unknown (ownership is provisional, a
    // settings read failed, or a rename is between its target and alias writes),
    // so the default we would derive cannot be attributed to a mode.
    // Seed NOTHING: a wrong-mode default persists — every later refresh keeps
    // the entry that already exists — while a missing entry is re-derived on
    // the next refresh, once the read succeeds.
    if (modeTargetRead.state === 'unavailable') return null;
    normalizedTemp = computeDefaultAirtreatmentShedTemperature({
      modeTarget: modeTargetRead.modeTarget,
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

export function enforceTemperatureWithoutOnOffOvershootBehaviors(params: {
  settings: Homey.App['homey']['settings'];
  snapshot: TargetDeviceSnapshot[];
  managed: BooleanMap;
  controllable: BooleanMap;
  overshootSettings: Record<string, OvershootBehaviorEntry>;
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): number {
  const {
    settings, snapshot, managed, controllable, overshootSettings, resolveOperatingModeForDevice,
  } = params;
  const updates = Object.fromEntries(snapshot.flatMap((device) => {
    if (device.powerCapable === false) return [];
    if (!isTemperatureWithoutOnOff(device)) return [];
    if (managed[device.id] !== true || controllable[device.id] !== true) return [];

    const update = resolveTemperatureWithoutOnOffOvershootUpdate({
      settings,
      device,
      existing: overshootSettings[device.id],
      resolveOperatingModeForDevice,
    });
    return update ? [[device.id, update] as const] : [];
  }));

  const updated = Object.keys(updates).length;
  if (!updated) return 0;

  settings.set(OVERSHOOT_BEHAVIORS, { ...overshootSettings, ...updates });
  return updated;
}

