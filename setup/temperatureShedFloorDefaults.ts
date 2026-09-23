/**
 * Shed-floor defaults for temperature devices with no on/off axis.
 *
 * A device PELS can only lower (no `onoff`) still has to be sheddable, so the
 * app assigns it a `set_temperature` shed behaviour without asking, and derives
 * the floor from the device's own mode target / setpoint. Split out of
 * `appDeviceSupport.ts`, which runs this when a device snapshot is refreshed.
 */
import type Homey from 'homey';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { readModeDeviceTarget } from '../lib/home/modeDeviceTargetsRead';
import { readShedBehaviorsSetting } from '../lib/home/shedBehaviorsRead';
import type { DeviceOperatingModeOutcome } from './homeRuntime/homeOperatingMode';
import { isTemperatureControlDevice } from '../packages/shared-domain/src/temperatureDeviceKind';
import {
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../lib/utils/settingsKeys';
import {
  AIRTREATMENT_SHED_FLOOR_C,
  COOLING_SHED_DEFAULT_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
} from '../packages/shared-domain/src/utils/airtreatmentConstants';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../packages/shared-domain/src/utils/airtreatmentShedTemperature';
import { getPrimaryTargetCapability } from '../lib/utils/targetCapabilities';
import {
  resolveShedBehavior, type ConfiguredShedBehavior,
} from '../packages/shared-domain/src/settings/shedBehaviors';

/**
 * Per-device active-mode resolution, carrying the producer's read-outcome
 * discriminant. Consumers that PERSIST a mode-derived value must skip on
 * `unavailable` rather than substitute a mode of their own.
 */
export type ResolveOperatingModeForDevice = (deviceId: string) => DeviceOperatingModeOutcome;


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

  // Through the key's owner (`lib/home/modeDeviceTargetsRead.ts`), which is the
  // ONE place this catalog's absent / malformed / read-failed split is decided.
  // A PROVEN-ABSENT catalog resolves to an empty one, so a home that configured
  // no mode targets has no target for this device — which is exactly what
  // `modeTarget: null` says. This function's own read used to answer `unavailable`
  // there and skip the seed outright, so a temperature-only device on such a home
  // got no limiting floor at all and could never be limited.
  const read = readModeDeviceTarget(
    params.settings,
    operatingMode.catalogHomeId,
    operatingMode.mode,
    params.deviceId,
  );
  return read.state === 'unavailable'
    ? { state: 'unavailable' }
    : { state: 'resolved', modeTarget: read.targetC };
}

/**
 * What the seed does for one device: leave its entry alone, or write this one.
 * Leaving it alone covers both "already right" and "cannot tell" — an unknown
 * mode seeds nothing, and a missing entry is re-derived on the next refresh.
 */
type OvershootSeed =
  | { kind: 'keep' }
  | { kind: 'write'; behavior: ConfiguredShedBehavior };

function resolveTemperatureWithoutOnOffOvershootUpdate(params: {
  settings: Homey.App['homey']['settings'];
  device: TargetDeviceSnapshot;
  existing: ConfiguredShedBehavior;
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): OvershootSeed {
  const { settings, device, existing, resolveOperatingModeForDevice } = params;
  const minFloorC = resolveTemperatureShedFloor(device);

  if (existing.action === 'set_temperature') {
    // The owner's setpoint entry: only a floor below the device's minimum is
    // corrected. The cooling limit is theirs and rides through untouched — a
    // re-seed that reset it would silently loosen a limited air conditioner.
    const normalizedTemp = Math.max(minFloorC, normalizeShedTemperature(existing.temperature));
    if (Math.abs(normalizedTemp - existing.temperature) <= 1e-9) return { kind: 'keep' };
    return { kind: 'write', behavior: { ...existing, temperature: normalizedTemp } };
  }

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
  if (modeTargetRead.state === 'unavailable') return { kind: 'keep' };
  return {
    kind: 'write',
    behavior: {
      action: 'set_temperature',
      temperature: computeDefaultAirtreatmentShedTemperature({
        modeTarget: modeTargetRead.modeTarget,
        currentTarget: getPrimaryTargetCapability(device.targets)?.value ?? null,
        minFloorC,
      }),
      // A first seed starts the cooling limit where the settings UI does.
      coolingTemperature: COOLING_SHED_DEFAULT_C,
    },
  };
}

export function enforceTemperatureWithoutOnOffOvershootBehaviors(params: {
  settings: Homey.App['homey']['settings'];
  snapshot: TargetDeviceSnapshot[];
  managed: BooleanMap;
  controllable: BooleanMap;
  resolveOperatingModeForDevice?: ResolveOperatingModeForDevice;
}): number {
  const {
    settings, snapshot, managed, controllable, resolveOperatingModeForDevice,
  } = params;
  // An unavailable read seeds nothing: the seed writes the WHOLE map back, so
  // seeding from a miss would erase every other device's limits.
  const read = readShedBehaviorsSetting(settings);
  if (read.state === 'unavailable') return 0;
  const overshootSettings = read.behaviors;
  const updates = Object.fromEntries(snapshot.flatMap((device) => {
    if (device.powerCapable === false) return [];
    if (!isTemperatureWithoutOnOff(device)) return [];
    if (managed[device.id] !== true || controllable[device.id] !== true) return [];

    const seed = resolveTemperatureWithoutOnOffOvershootUpdate({
      settings,
      device,
      existing: resolveShedBehavior(overshootSettings, device.id),
      resolveOperatingModeForDevice,
    });
    return seed.kind === 'write' ? [[device.id, seed.behavior] as const] : [];
  }));

  const updated = Object.keys(updates).length;
  if (!updated) return 0;

  settings.set(OVERSHOOT_BEHAVIORS, { ...overshootSettings, ...updates });
  return updated;
}
