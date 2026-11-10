/**
 * A temperature a Flow asks a managed device to hold for a while, in place of
 * its mode target: the owner of the `temporary_temperature_targets` key.
 *
 * ## What it replaces, and what it does not
 *
 * While one is in force, it stands where the mode target stands in
 * `temperatureSetpoints.ts`: the setpoint PELS keeps the device at, without the
 * price shift or the surplus lift. Everything that limits a device still applies
 * on top: power limiting writes its own limit, and a Smart task's deadline floor
 * still holds the setpoint at least at the task's target. It is an input to the
 * one place a setpoint is computed, never a second place that commands one
 * (`notes/temperature-ownership.md`).
 *
 * ## Lifetime
 *
 * An entry carries the absolute time it ends, so a restart or a mode switch
 * changes nothing about it. It is in force while `untilMs` is in the future and
 * inert after: the next plan build reads the mode target again, with no timer and
 * no transition to run. Expired entries are dropped on the next write. Its
 * duration is capped at {@link MAX_TEMPORARY_TEMPERATURE_MINUTES}, so an entry
 * for a device that has since been removed is inert within a day.
 *
 * ## Read policy
 *
 * The key is runtime-only. A malformed entry is dropped and its siblings kept. A
 * read that throws or answers a malformed map means no temporary temperature:
 * the mode target is the baseline every other path already falls back to, so
 * the device lands where it would be without the Flow.
 */
import type { SettingsPort } from '../ports/homeyRuntime';
import { TEMPERATURE_CONTROL_MODES, TEMPORARY_TEMPERATURE_TARGETS } from '../utils/settingsKeys';
import { readTemperatureControlModes } from '../../packages/shared-domain/src/settings/temperatureControl';

export const MAX_TEMPORARY_TEMPERATURE_MINUTES = 24 * 60;

export type TemporaryTemperatureTarget = {
  /** Already normalized to the device's target range and step. */
  targetC: number;
  untilMs: number;
};

type TemporaryTemperatureTargetMap = Readonly<Record<string, TemporaryTemperatureTarget>>;

const isEntry = (value: unknown): value is TemporaryTemperatureTarget => {
  if (value === null || typeof value !== 'object') return false;
  const { targetC, untilMs } = value as Record<string, unknown>;
  return typeof targetC === 'number' && Number.isFinite(targetC)
    && typeof untilMs === 'number' && Number.isFinite(untilMs);
};

/** `null` when the map itself is unreadable; malformed entries are dropped. */
function readMap(settings: Pick<SettingsPort, 'get'>): TemporaryTemperatureTargetMap | null {
  let raw: unknown;
  try {
    raw = settings.get(TEMPORARY_TEMPERATURE_TARGETS);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.fromEntries(Object.entries(raw).filter(([, entry]) => isEntry(entry)));
}

/** The device's temporary temperature while it is in force, or `null`. */
export function readActiveTemporaryTemperatureC(
  settings: Pick<SettingsPort, 'get'>,
  deviceId: string,
  nowMs: number,
): number | null {
  const entry = readMap(settings)?.[deviceId];
  return entry !== undefined && entry.untilMs > nowMs ? entry.targetC : null;
}

export type TemporaryTemperatureWrite =
  | 'written'
  | 'unchanged'
  /** "Keep the new temperature" hands the setpoint to someone else: PELS writes none. */
  | 'temperature_control_off'
  | 'unavailable';

const withoutExpired = (
  map: TemporaryTemperatureTargetMap,
  nowMs: number,
): Record<string, TemporaryTemperatureTarget> => (
  Object.fromEntries(Object.entries(map).filter(([, entry]) => entry.untilMs > nowMs))
);

function controlModeAllows(settings: Pick<SettingsPort, 'get'>, deviceId: string): boolean | null {
  try {
    const raw = settings.get(TEMPERATURE_CONTROL_MODES);
    if (raw === null || raw === undefined) return true;
    const modes = readTemperatureControlModes(raw);
    return modes ? modes[deviceId] !== 'external' : null;
  } catch {
    return null;
  }
}

/**
 * Start (or replace) a device's temporary temperature, ending `minutes` from
 * `nowMs`. The caller has normalized `targetC` for the device and bounded
 * `minutes` to 1–{@link MAX_TEMPORARY_TEMPERATURE_MINUTES}.
 */
export function startTemporaryTemperature(
  settings: SettingsPort,
  deviceId: string,
  request: { targetC: number; minutes: number },
  nowMs: number,
): TemporaryTemperatureWrite {
  const allowed = controlModeAllows(settings, deviceId);
  if (allowed === null) return 'unavailable';
  if (!allowed) return 'temperature_control_off';
  const map = readMap(settings);
  if (map === null) return 'unavailable';
  settings.set(TEMPORARY_TEMPERATURE_TARGETS, {
    ...withoutExpired(map, nowMs),
    [deviceId]: { targetC: request.targetC, untilMs: nowMs + request.minutes * 60_000 },
  });
  return 'written';
}

/** End a device's temporary temperature now; the next plan returns it to its mode target. */
export function endTemporaryTemperature(
  settings: SettingsPort,
  deviceId: string,
  nowMs: number,
): Exclude<TemporaryTemperatureWrite, 'temperature_control_off'> {
  const map = readMap(settings);
  if (map === null) return 'unavailable';
  const active = withoutExpired(map, nowMs);
  if (!Object.hasOwn(active, deviceId)) return 'unchanged';
  const { [deviceId]: _ended, ...rest } = active;
  settings.set(TEMPORARY_TEMPERATURE_TARGETS, rest);
  return 'written';
}
