// Per-device learned thermostat deadband (°C). Pure helpers for read,
// sanitise, clamp, EMA-update, and write. Stays as a plain
// `Record<deviceId, number>` because the value is self-healing — loss of
// persisted state just resets a device to 0 over-command and the EMA
// relearns from the next met/stalled run. No abandon-grace, no init marker,
// no debounce: write-through on every learning event is fine for a small map
// touched at most once per smart-task finalize.

import { isFiniteNumber } from './appTypeGuards';

// Maximum over-command added to the user's deadline target. Bounds the
// failure mode of a corrupted EMA — at worst the room overshoots by 1 °C.
export const LEARNED_THERMOSTAT_DEADBAND_MAX_C = 1.0;

// EMA weights: 0.7 old / 0.3 new. Slow enough to filter sample noise from
// sensor reporting cadence, fast enough that a device with a stable deadband
// converges within ~5 met/stalled sessions.
export const LEARNED_THERMOSTAT_DEADBAND_EMA_OLD = 0.7;
export const LEARNED_THERMOSTAT_DEADBAND_EMA_NEW = 0.3;

export type LearnedThermostatDeadbandMap = Readonly<Record<string, number>>;

const clampDeadband = (value: number): number => {
  if (value <= 0) return 0;
  if (value >= LEARNED_THERMOSTAT_DEADBAND_MAX_C) return LEARNED_THERMOSTAT_DEADBAND_MAX_C;
  return value;
};

// Normalise the persisted shape. Drops keys whose values aren't finite
// numbers (defensive against settings drift / corruption per
// `feedback_homey_sdk_unreliable`) and clamps any survivors into the bounded
// range. Returns an empty object when the persisted value is missing or not
// a plain object — devices then fall back to 0 over-command and relearn.
export const normaliseLearnedThermostatDeadbandMap = (value: unknown): LearnedThermostatDeadbandMap => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap<[string, number]>(([deviceId, raw]) => {
      if (typeof deviceId !== 'string' || deviceId.length === 0) return [];
      if (!isFiniteNumber(raw)) return [];
      return [[deviceId, clampDeadband(raw)]];
    });
  return Object.fromEntries(entries);
};

// Flat-value reader used by `buildDeferredTargetOverrides` and the diagnostic
// builder. Defaults to 0 when the device has no learned value yet — the
// consumer never branches on "is this device known to the map", per
// `feedback_layering_resolution_in_producer`.
export const getLearnedThermostatDeadbandC = (
  map: LearnedThermostatDeadbandMap,
  deviceId: string,
): number => {
  const stored = map[deviceId];
  if (!isFiniteNumber(stored)) return 0;
  return clampDeadband(stored);
};

// EMA-update a single device's learned deadband against a fresh observed
// deadband (= commandedSetpointC − currentTemperatureC at the moment the
// device transitioned to measured-idle). Returns the next map; the caller
// persists. The observed value is clamped before mixing so a noisy sample
// can't push the EMA outside the bounded range in a single step.
export const updateLearnedThermostatDeadband = (params: {
  map: LearnedThermostatDeadbandMap;
  deviceId: string;
  observedDeadbandC: number;
}): LearnedThermostatDeadbandMap => {
  const { map, deviceId, observedDeadbandC } = params;
  if (!isFiniteNumber(observedDeadbandC)) return map;
  const clampedObserved = clampDeadband(observedDeadbandC);
  const prior = getLearnedThermostatDeadbandC(map, deviceId);
  const next = clampDeadband(
    prior * LEARNED_THERMOSTAT_DEADBAND_EMA_OLD
    + clampedObserved * LEARNED_THERMOSTAT_DEADBAND_EMA_NEW,
  );
  // Skip the write when EMA produced no movement (e.g. prior=0 and observed=0
  // after clamping a negative reading). Avoids churning persisted state on
  // every clean session.
  if (next === prior && deviceId in map) return map;
  return { ...map, [deviceId]: next };
};
