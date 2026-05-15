/**
 * Idle-state classification for devices commanded on but drawing ~0 W.
 * Output is consumed by the Settings UI and structured logs only — the
 * planner already treats `measuredPowerKw = 0` correctly via
 * `getCurrentDrawKw`, so this module does not feed back into plan or restore
 * accounting.
 *
 * Two distinct states are produced:
 *
 *  - `near_target_idle`: device is at/near its temperature setpoint and has
 *    been idle long enough that this looks like a deliberate hold (e.g. a
 *    water heater that stops drawing within its internal hysteresis band).
 *    Surfaced as a neutral status line on the device card.
 *
 *  - `unresponsive`: device is well below setpoint and has been idle long
 *    enough that the most likely explanation is a fault (tripped breaker,
 *    lost contactor, child-lock, wrong wiring). Surfaced as a warning chip
 *    so the user can act.
 *
 * Eligibility gates are evaluated inside this module (`isEligibleForIdle`).
 * Callers populate `pelsCommandedShed` from the plan snapshot's `shedAction`
 * so the detector never reports on a device PELS itself is suppressing —
 * the gate is the detector's responsibility, not the caller's.
 *
 * Only temperature-bearing devices are eligible: without a setpoint reading
 * we have no way to distinguish "satisfied hold" from "broken". EV chargers
 * have their own pause modelling (`ev_pause`) and are excluded.
 */
import { isFiniteNumber } from '../utils/appTypeGuards';

export type IdleClassification = 'active' | 'near_target_idle' | 'unresponsive';

export const IDLE_MEASURED_POWER_THRESHOLD_KW = 0.05;
export const IDLE_HOLD_MIN_DURATION_MS = 5 * 60 * 1000;
export const IDLE_UNRESPONSIVE_MIN_DURATION_MS = 15 * 60 * 1000;
export const NEAR_TARGET_TEMPERATURE_DELTA_C = 5;
export const NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C = 5.5;

export type IdleDetectorInput = {
  deviceId: string;
  now: number;
  measuredPowerKw?: number;
  currentTemperature?: number;
  targetTemperature?: number;
  /** True when the device is observably on right now (binary or stepped). */
  observedOn: boolean;
  /** True when the observation is stale and cannot be trusted as authoritative. */
  observationStale?: boolean;
  /**
   * True when PELS is the reason the device is off / not drawing — e.g. it is
   * currently shed, has a pending shed command, or has been driven to its off
   * step. The detector never flips while we are the cause.
   */
  pelsCommandedShed: boolean;
  /**
   * Exclude devices that should never be classified — EV chargers (handled by
   * the ev_pause path) and devices without temperature observability.
   */
  hasTemperatureSetpoint: boolean;
  isEvCharger: boolean;
};

export type IdleDetectorEntry = {
  idleSinceMs: number;
  lastClassification: IdleClassification;
};

export type IdleDetectorState = Map<string, IdleDetectorEntry>;

export type IdleDetectorResult = {
  classification: IdleClassification;
  /** Previous classification — undefined when the device has no prior entry. */
  previousClassification?: IdleClassification;
  /**
   * Milliseconds of continuous idle in the current streak. Preserved across
   * the active-transition so the cleared-event payload can report how long
   * the device was actually held before resuming.
   */
  idleDurationMs: number;
  /** Current vs target gap when both are known; undefined otherwise. */
  temperatureGapC?: number;
};

const measuredIsIdle = (kw: number | undefined): boolean => (
  isFiniteNumber(kw) && kw >= 0 && kw <= IDLE_MEASURED_POWER_THRESHOLD_KW
);

const computeTemperatureGap = (
  current: number | undefined,
  target: number | undefined,
): number | undefined => {
  if (!isFiniteNumber(current) || !isFiniteNumber(target)) return undefined;
  return target - current;
};

const isEligibleForIdle = (input: IdleDetectorInput): boolean => {
  if (input.isEvCharger) return false;
  if (!input.hasTemperatureSetpoint) return false;
  if (input.observationStale === true) return false;
  if (!input.observedOn) return false;
  if (input.pelsCommandedShed) return false;
  return measuredIsIdle(input.measuredPowerKw);
};

const classifyByGapAndDuration = (
  gap: number | undefined,
  durationMs: number,
  previous: IdleClassification | undefined,
): IdleClassification => {
  if (gap === undefined) return 'active';

  const inHoldWindow = previous === 'near_target_idle'
    ? gap <= NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C
    : gap <= NEAR_TARGET_TEMPERATURE_DELTA_C;

  if (inHoldWindow) {
    return durationMs >= IDLE_HOLD_MIN_DURATION_MS ? 'near_target_idle' : 'active';
  }
  return durationMs >= IDLE_UNRESPONSIVE_MIN_DURATION_MS ? 'unresponsive' : 'active';
};

/**
 * Classify a single device's idle state and mutate `state` to reflect the new
 * idle streak / classification. Returns the classification plus context that
 * callers use to emit diagnostics and copy.
 */
export function classifyIdleState(
  input: IdleDetectorInput,
  state: IdleDetectorState,
): IdleDetectorResult {
  const previousEntry = state.get(input.deviceId);
  const previousClassification = previousEntry?.lastClassification;

  if (!isEligibleForIdle(input)) {
    const idleDurationMs = previousEntry
      ? Math.max(0, input.now - previousEntry.idleSinceMs)
      : 0;
    if (previousEntry) state.delete(input.deviceId);
    return {
      classification: 'active',
      previousClassification,
      idleDurationMs,
      temperatureGapC: computeTemperatureGap(input.currentTemperature, input.targetTemperature),
    };
  }

  const idleSinceMs = previousEntry?.idleSinceMs ?? input.now;
  const idleDurationMs = Math.max(0, input.now - idleSinceMs);
  const gap = computeTemperatureGap(input.currentTemperature, input.targetTemperature);
  const classification = classifyByGapAndDuration(gap, idleDurationMs, previousClassification);

  state.set(input.deviceId, { idleSinceMs, lastClassification: classification });
  return {
    classification,
    previousClassification,
    idleDurationMs,
    temperatureGapC: gap,
  };
}

/** Drop tracking state for devices no longer present in the live snapshot. */
export function pruneIdleDetectorState(
  state: IdleDetectorState,
  activeDeviceIds: Iterable<string>,
): void {
  const live = new Set(activeDeviceIds);
  for (const id of [...state.keys()]) {
    if (!live.has(id)) state.delete(id);
  }
}
