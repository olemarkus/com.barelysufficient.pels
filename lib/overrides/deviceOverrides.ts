/**
 * Device overrides: one setting PELS holds on one device until a stated time,
 * in place of what it would otherwise decide. This module owns the
 * `device_override.<deviceId>` keys and an override's lifetime.
 *
 * ## Kinds
 *
 * One today: a temperature. While in force it stands where the mode target
 * stands in `lib/thermostat/temperatureSetpoints.ts`: the setpoint PELS keeps the
 * device at, without the price shift or the surplus lift, whatever mode the home
 * switches to. Power limiting still applies on top: it writes its own limit. A
 * Smart task on the device gives way: while the override is in force the task's
 * decoration decides nothing for the device
 * (`DeferredObjectiveDecorationController`), and a deadline reached meanwhile
 * ends the task without its fallback write. It is an input to the one place a
 * setpoint is computed, never a second place that commands one
 * (`notes/temperature-ownership.md`).
 *
 * ## Lifetime
 *
 * An override carries the absolute time it ends, so a restart or a mode switch
 * changes nothing about it. It is in force while `untilMs` is in the future and
 * inert after: the next plan build reads what PELS would otherwise decide, with
 * no timer and no transition to run, and no record of what the device was set to
 * before. It is ended early by storing an end time of now. An end time further
 * ahead than `MAX_DEVICE_OVERRIDE_MINUTES` is not an override.
 *
 * ## Who writes
 *
 * The settings UI writes a device's key through the settings bridge; Flow cards
 * start and end one through this module. A device has at most one override, and
 * a new one replaces it.
 *
 * ## Read policy
 *
 * A key that is missing, unreadable or malformed means no override: what PELS
 * would otherwise decide is the baseline every other path already falls back to.
 *
 * Earlier versions stored a Flow's temporary temperature in one map,
 * `temporary_temperature_targets`, where it lasted at most a day. An entry there
 * still counts for a device whose own key holds nothing, so an upgrade does not
 * cut one short. Nothing writes that map any more.
 */
import {
  deviceOverrideKey,
  isDeviceOverrideInForce,
  isDeviceOverrideKey,
  parseDeviceOverride,
  type DeviceOverride,
  type DeviceOverrideSetting,
} from '../../packages/shared-domain/src/settings/deviceOverrides';
import { readTemperatureControlModes } from '../../packages/shared-domain/src/settings/temperatureControl';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { TEMPERATURE_CONTROL_MODES, TEMPORARY_TEMPERATURE_TARGETS } from '../utils/settingsKeys';

// How long the older map's entries could last. An ended override's key is kept
// this long, so that it keeps hiding an entry in that map for the same device.
const LEGACY_MAX_MS = 24 * 60 * 60_000;

function readLegacyTemperature(
  settings: Pick<SettingsPort, 'get'>,
  deviceId: string,
): DeviceOverride | null {
  const map = settings.get(TEMPORARY_TEMPERATURE_TARGETS);
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry: unknown = (map as Record<string, unknown>)[deviceId];
  if (entry === null || typeof entry !== 'object') return null;
  const { targetC, untilMs } = entry as Record<string, unknown>;
  return parseDeviceOverride({ untilMs, setting: { type: 'temperature', targetC } });
}

/** The device's override while it is in force, or `null`. */
export function readActiveDeviceOverride(
  settings: Pick<SettingsPort, 'get'>,
  deviceId: string,
  nowMs: number,
): DeviceOverride | null {
  try {
    const override = parseDeviceOverride(settings.get(deviceOverrideKey(deviceId)))
      ?? readLegacyTemperature(settings, deviceId);
    return override !== null && isDeviceOverrideInForce(override, nowMs) ? override : null;
  } catch {
    return null;
  }
}

/** A temperature override in force on a device: the temperature and when it ends. */
export type ActiveTemperatureOverride = { targetC: number; untilMs: number };

/** The device's temperature override while it is in force, or `null`. */
export function readActiveTemperatureOverride(
  settings: Pick<SettingsPort, 'get'>,
  deviceId: string,
  nowMs: number,
): ActiveTemperatureOverride | null {
  const override = readActiveDeviceOverride(settings, deviceId, nowMs);
  return override === null ? null : { targetC: override.setting.targetC, untilMs: override.untilMs };
}

export type DeviceOverrideWrite =
  | 'written'
  | 'unchanged'
  /** "Keep the new temperature" hands the setpoint to someone else: PELS writes none. */
  | 'temperature_control_off'
  | 'unavailable';

function temperatureControlAllows(settings: Pick<SettingsPort, 'get'>, deviceId: string): boolean | null {
  try {
    const raw = settings.get(TEMPERATURE_CONTROL_MODES);
    if (raw === null || raw === undefined) return true;
    const modes = readTemperatureControlModes(raw);
    return modes ? modes[deviceId] !== 'external' : null;
  } catch {
    return null;
  }
}

/** Remove keys whose override ended long enough ago that nothing reads them. */
function dropEndedOverrides(settings: SettingsPort, nowMs: number): void {
  const keyList = readSettingsKeyList(settings);
  if (keyList.status === 'unavailable') return;
  for (const key of keyList.keys) {
    if (!isDeviceOverrideKey(key)) continue;
    const override = parseDeviceOverride(settings.get(key));
    if (override !== null && override.untilMs <= nowMs - LEGACY_MAX_MS) settings.unset(key);
  }
}

/**
 * Start (or replace) a device's override, ending `minutes` from `nowMs`. The
 * caller has normalized the setting for the device and bounded `minutes` to
 * 1–`MAX_DEVICE_OVERRIDE_MINUTES`.
 */
export function startDeviceOverride(
  settings: SettingsPort,
  deviceId: string,
  request: { setting: DeviceOverrideSetting; minutes: number },
  nowMs: number,
): DeviceOverrideWrite {
  const allowed = temperatureControlAllows(settings, deviceId);
  if (allowed === null) return 'unavailable';
  if (!allowed) return 'temperature_control_off';
  try {
    dropEndedOverrides(settings, nowMs);
    const override: DeviceOverride = { untilMs: nowMs + request.minutes * 60_000, setting: request.setting };
    settings.set(deviceOverrideKey(deviceId), override);
    return 'written';
  } catch {
    return 'unavailable';
  }
}

/** End a device's override now; the next plan returns it to what PELS would otherwise decide. */
export function endDeviceOverride(
  settings: SettingsPort,
  deviceId: string,
  nowMs: number,
): Exclude<DeviceOverrideWrite, 'temperature_control_off'> {
  const active = readActiveDeviceOverride(settings, deviceId, nowMs);
  if (active === null) return 'unchanged';
  try {
    const ended: DeviceOverride = { ...active, untilMs: nowMs };
    settings.set(deviceOverrideKey(deviceId), ended);
    return 'written';
  } catch {
    return 'unavailable';
  }
}
