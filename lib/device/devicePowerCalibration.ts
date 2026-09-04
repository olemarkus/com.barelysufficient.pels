/**
 * Per-device-per-step power calibration store.
 *
 * Pure functions over a {@link PowerCalibrationSnapshot}: callers own the
 * snapshot and pass it in / get the updated value out. The settings-store
 * layer (`lib/device/devicePowerCalibrationStore.ts`) loads, persists, and
 * dispatches samples; this module only contains the EMA math, gating
 * policy, and query helpers.
 *
 * One query primitive is exposed for a step's learned power. Samples are
 * accepted only inside the configured step band, so learned values never
 * exceed the configured step ceiling.
 */

import type {
  DeviceCalibration,
  PowerCalibrationSnapshot,
  PowerCalibrationVersion,
  StepCalibration,
} from '../../packages/contracts/src/powerCalibration';
import { isFiniteNumber } from '../utils/appTypeGuards';

/**
 * Runtime version constant for {@link PowerCalibrationSnapshot}. Defined here
 * (not in the contracts package) so Homey runtime code does not value-import
 * from `packages/contracts/src/**`, which is deploy-excluded.
 */
export const POWER_CALIBRATION_VERSION: PowerCalibrationVersion = 1;

export function createEmptyPowerCalibrationSnapshot(): PowerCalibrationSnapshot {
  return { version: POWER_CALIBRATION_VERSION, devices: {} };
}

const MIN_ALPHA = 0.05;
const MAX_ALPHA = 1;
const CONFIDENCE_MIN_SAMPLES = 5;
const CONFIDENCE_MIN_SUSTAINED_SECONDS = 300;
const DEFAULT_FRESHNESS_WINDOW_MS = 60_000;
const SUSTAINED_SECONDS_GAP_CAP_MS = 60_000;
const NAMEPLATE_TOLERANCE_RATIO = 0.02;
const ANOMALY_MULTIPLIER = 3;
const RECENT_DRAW_DEFAULT_MIN_KW = 0.05;

export type RecordSampleInput = {
  deviceId: string;
  stepId: string;
  measuredPowerKw: number;
  nameplateKw: number;
  lowerStepCeilingKw?: number;
  dataObservedAtMs?: number;
  nowMs: number;
};

export type RecordSampleSkipReason =
  | 'invalid_input'
  | 'no_nameplate'
  | 'stale_observation'
  | 'below_floor'
  | 'below_lower_step'
  | 'above_step_ceiling'
  | 'anomaly';

export type RecordSampleOutcome =
  | {
    accepted: true;
    snapshot: PowerCalibrationSnapshot;
    /** True when the entry was created or nameplate-reset by this sample. */
    reset: boolean;
  }
  | {
    accepted: false;
    snapshot: PowerCalibrationSnapshot;
    reason: RecordSampleSkipReason;
  };

export type RecordSampleConfig = {
  freshnessWindowMs?: number;
  minActiveFloorKw?: number;
};

export type HasRecentDrawAtParams = {
  snapshot: PowerCalibrationSnapshot;
  deviceId: string;
  stepId: string;
  windowMs: number;
  nowMs: number;
  minKw?: number;
  nameplateKw?: number;
};

/**
 * Returns a defensively-typed snapshot. Unknown shapes degrade to an empty
 * snapshot rather than throwing; partial step records are dropped silently.
 * Use this whenever a snapshot crosses a persistence boundary.
 */
export function normalizePowerCalibrationSnapshot(value: unknown): PowerCalibrationSnapshot {
  if (!isRecord(value)) return createEmptyPowerCalibrationSnapshot();
  const versionRaw = (value as { version?: unknown }).version;
  if (versionRaw !== POWER_CALIBRATION_VERSION) return createEmptyPowerCalibrationSnapshot();
  const devicesRaw = (value as { devices?: unknown }).devices;
  if (!isRecord(devicesRaw)) return createEmptyPowerCalibrationSnapshot();

  const entries = Object.entries(devicesRaw).flatMap(([deviceId, deviceRaw]) => {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return [];
    const normalized = normalizeDeviceCalibration(deviceRaw);
    return normalized ? [[deviceId, normalized] as const] : [];
  });
  return {
    version: POWER_CALIBRATION_VERSION,
    devices: Object.fromEntries(entries),
  };
}

export function recordSample(
  snapshot: PowerCalibrationSnapshot,
  input: RecordSampleInput,
  config: RecordSampleConfig = {},
): RecordSampleOutcome {
  const existingDevice = snapshot.devices[input.deviceId];
  const existingStep = existingDevice?.steps[input.stepId];
  const gateResult = evaluateRecordSampleGates({ input, config });
  if (gateResult !== null) {
    return { accepted: false, snapshot, reason: gateResult };
  }

  const shouldReset = existingStep === undefined
    || hasNameplateDriftedBeyondTolerance({
      previousNameplateKw: existingStep.nameplateAtSampleKw,
      nextNameplateKw: input.nameplateKw,
    });

  if (!shouldReset && existingStep !== undefined && isAnomalousSample(existingStep, input)) {
    return { accepted: false, snapshot, reason: 'anomaly' };
  }

  const baseStep: StepCalibration = (shouldReset || existingStep === undefined)
    ? buildResetStep(input)
    : updateExistingStep(existingStep, input);

  const nextDevice: DeviceCalibration = {
    steps: { ...(existingDevice?.steps ?? {}), [input.stepId]: baseStep },
    lastTouchedMs: input.nowMs,
  };
  const nextSnapshot: PowerCalibrationSnapshot = {
    version: POWER_CALIBRATION_VERSION,
    devices: { ...snapshot.devices, [input.deviceId]: nextDevice },
  };
  return { accepted: true, snapshot: nextSnapshot, reset: shouldReset };
}

/**
 * The learned power for one `(device, step)` pair, in kW — the ONE number the
 * calibration store has about a rung.
 *
 * There used to be two, `getAdmissionPowerKw` ("is it safe to admit this
 * draw?") and `getDeliveryPowerKw` ("how much will I actually deliver?"), and
 * they were the same body. The names promised a band the data never held:
 * samples above the caller-provided nameplate are rejected before they reach
 * the EMA, so one estimate comes out — at or below the configured step power,
 * and the nameplate itself below confidence. Consumers that pick "the
 * conservative end" have to do it against something else (the meter), not
 * against a second calibration figure that does not exist.
 */
export function getStepPowerKw(
  snapshot: PowerCalibrationSnapshot,
  deviceId: string,
  stepId: string,
  nameplateKw: number,
): number {
  return getBoundedConfidentPowerKw(snapshot, deviceId, stepId, nameplateKw);
}

function getBoundedConfidentPowerKw(
  snapshot: PowerCalibrationSnapshot,
  deviceId: string,
  stepId: string,
  nameplateKw: number,
): number {
  const step = snapshot.devices[deviceId]?.steps[stepId];
  if (step === undefined || !isConfident(step)) return Math.max(0, nameplateKw);
  if (!isStepUsableForNameplate(step, nameplateKw)) return Math.max(0, nameplateKw);
  return Math.max(0, Math.min(nameplateKw, step.observedKw));
}

/**
 * True when the calibration store has confidence-qualified observations for
 * this `(deviceId, stepId)` pair. Callers that gate behavior on calibration
 * output should consult this *first* so warm-up samples are treated as
 * "no opinion" rather than authoritative evidence.
 */
export function isStepCalibrationConfident(
  snapshot: PowerCalibrationSnapshot,
  deviceId: string,
  stepId: string,
  nameplateKw?: number,
): boolean {
  const step = snapshot.devices[deviceId]?.steps[stepId];
  return step !== undefined
    && isConfident(step)
    && isStepUsableForNameplate(step, nameplateKw);
}

/**
 * True when there is a positive observed-draw record for this `(deviceId,
 * stepId)` within `windowMs` ago. Used to gate optimistic plan moves
 * (boost-driven escalation) that require evidence the device is actually
 * accepting load at its current step.
 *
 * `minKw` defaults to 50W to avoid claiming "recent draw" from idle
 * thermostats whose measured value briefly bounced above the floor.
 */
export function hasRecentDrawAt(params: HasRecentDrawAtParams): boolean {
  const { snapshot, deviceId, stepId, windowMs, nowMs } = params;
  const minKw = params.minKw ?? RECENT_DRAW_DEFAULT_MIN_KW;
  const step = snapshot.devices[deviceId]?.steps[stepId];
  if (step === undefined) return false;
  if (!isStepUsableForNameplate(step, params.nameplateKw)) return false;
  if (step.observedKw < minKw) return false;
  return (nowMs - step.lastSampleMs) <= windowMs;
}

/**
 * Drop device entries whose newest sample is older than `maxAgeMs`. Useful
 * for keeping the persisted snapshot bounded; safe to call periodically.
 */
export function pruneStale(
  snapshot: PowerCalibrationSnapshot,
  maxAgeMs: number,
  nowMs: number,
): PowerCalibrationSnapshot {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return snapshot;
  const survivingEntries = Object.entries(snapshot.devices).filter(
    ([, device]) => (nowMs - device.lastTouchedMs) <= maxAgeMs,
  );
  if (survivingEntries.length === Object.keys(snapshot.devices).length) return snapshot;
  return {
    version: POWER_CALIBRATION_VERSION,
    devices: Object.fromEntries(survivingEntries),
  };
}

/**
 * Overlay in-memory accepted state on recovered persisted history before the
 * first post-grace write. Used when the boot-time settings read was suspect
 * (abandon-grace engaged) and a recovery re-read later returned real history:
 * writing the in-memory snapshot alone would overwrite everything the boot
 * read failed to deliver.
 *
 * Granularity is per (device, step), not per device: step EMAs are
 * independent, and a device re-observed since boot has typically only visited
 * one or two of its steps — dropping the recovered EMAs for the others would
 * discard exactly the history this merge exists to preserve. On a collision
 * the in-memory step wins (its EMA reflects post-boot reality; two EMAs with
 * different anchors cannot be meaningfully averaged).
 */
export function mergeRecoveredCalibrationHistory(params: {
  inMemory: PowerCalibrationSnapshot;
  recovered: PowerCalibrationSnapshot;
}): PowerCalibrationSnapshot {
  const { inMemory, recovered } = params;
  const overlapping = Object.entries(inMemory.devices).flatMap(([deviceId, inMemoryDevice]) => {
    const recoveredDevice = recovered.devices[deviceId];
    if (recoveredDevice === undefined) return [];
    return [[deviceId, {
      steps: { ...recoveredDevice.steps, ...inMemoryDevice.steps },
      lastTouchedMs: Math.max(recoveredDevice.lastTouchedMs, inMemoryDevice.lastTouchedMs),
    }] as const];
  });
  return {
    version: POWER_CALIBRATION_VERSION,
    devices: {
      ...recovered.devices,
      ...inMemory.devices,
      ...Object.fromEntries(overlapping),
    },
  };
}

function evaluateRecordSampleGates(params: {
  input: RecordSampleInput;
  config: RecordSampleConfig;
}): RecordSampleSkipReason | null {
  const { input, config } = params;
  if (!isValidInput(input)) return 'invalid_input';
  if (input.nameplateKw <= 0) return 'no_nameplate';
  if (isStaleObservation(input, config.freshnessWindowMs)) return 'stale_observation';
  if (isBelowActiveFloor(input, config.minActiveFloorKw)) return 'below_floor';
  if (isBelowLowerStep(input)) return 'below_lower_step';
  if (isAboveStepCeiling(input)) return 'above_step_ceiling';
  return null;
}

function isStaleObservation(
  input: RecordSampleInput,
  freshnessWindowMs: number | undefined,
): boolean {
  if (typeof input.dataObservedAtMs !== 'number') return false;
  const window = freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  return (input.nowMs - input.dataObservedAtMs) > window;
}

function isBelowActiveFloor(
  input: RecordSampleInput,
  minActiveFloorKw: number | undefined,
): boolean {
  const floor = Math.max(minActiveFloorKw ?? 0, 0.05, 0.1 * input.nameplateKw);
  return input.measuredPowerKw < floor;
}

function isBelowLowerStep(input: RecordSampleInput): boolean {
  return isFiniteNumber(input.lowerStepCeilingKw)
    && input.lowerStepCeilingKw > 0
    && input.measuredPowerKw <= input.lowerStepCeilingKw;
}

function isAboveStepCeiling(input: RecordSampleInput): boolean {
  return input.measuredPowerKw > input.nameplateKw;
}

function hasNameplateDriftedBeyondTolerance(params: {
  previousNameplateKw: number;
  nextNameplateKw: number;
}): boolean {
  const denominator = Math.max(params.previousNameplateKw, 1e-6);
  const drift = Math.abs(params.previousNameplateKw - params.nextNameplateKw) / denominator;
  return drift > NAMEPLATE_TOLERANCE_RATIO;
}

function isStepUsableForNameplate(
  step: StepCalibration,
  nameplateKw: number | undefined,
): boolean {
  if (nameplateKw === undefined) return true;
  if (!isFiniteNumber(nameplateKw) || nameplateKw <= 0) return false;
  return !hasNameplateDriftedBeyondTolerance({
    previousNameplateKw: step.nameplateAtSampleKw,
    nextNameplateKw: nameplateKw,
  });
}

function isAnomalousSample(step: StepCalibration, input: RecordSampleInput): boolean {
  if (!isConfident(step)) return false;
  return Math.abs(input.measuredPowerKw - step.observedKw) > ANOMALY_MULTIPLIER * step.observedKw;
}

function buildResetStep(input: RecordSampleInput): StepCalibration {
  return {
    observedKw: input.measuredPowerKw,
    nameplateAtSampleKw: input.nameplateKw,
    samples: 1,
    sustainedSeconds: 0,
    lastSampleMs: input.nowMs,
  };
}

function updateExistingStep(prev: StepCalibration, input: RecordSampleInput): StepCalibration {
  const nextSamples = prev.samples + 1;
  // Running-mean weight (1/n) until samples cross the MIN_ALPHA floor, at
  // which point the update degrades to a slow EMA that absorbs seasonal
  // drift without erasing the established baseline. Welford-style: each new
  // sample contributes 1/nextSamples to the mean.
  const alpha = clampAlpha(1 / nextSamples);
  const observedKw = alpha * input.measuredPowerKw + (1 - alpha) * prev.observedKw;
  const elapsedMs = Math.max(0, Math.min(SUSTAINED_SECONDS_GAP_CAP_MS, input.nowMs - prev.lastSampleMs));
  return {
    observedKw,
    nameplateAtSampleKw: input.nameplateKw,
    samples: nextSamples,
    sustainedSeconds: prev.sustainedSeconds + elapsedMs / 1000,
    lastSampleMs: input.nowMs,
  };
}

function isConfident(step: StepCalibration): boolean {
  return step.samples >= CONFIDENCE_MIN_SAMPLES
    && step.sustainedSeconds >= CONFIDENCE_MIN_SUSTAINED_SECONDS;
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return MAX_ALPHA;
  return Math.min(MAX_ALPHA, Math.max(MIN_ALPHA, value));
}

function isValidInput(input: RecordSampleInput): boolean {
  return typeof input.deviceId === 'string'
    && input.deviceId.length > 0
    && typeof input.stepId === 'string'
    && input.stepId.length > 0
    && isFiniteNumber(input.measuredPowerKw)
    && input.measuredPowerKw >= 0
    && isFiniteNumber(input.nameplateKw)
    && isFiniteNumber(input.nowMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDeviceCalibration(value: unknown): DeviceCalibration | null {
  if (!isRecord(value)) return null;
  const stepsRaw = (value as { steps?: unknown }).steps;
  const lastTouchedRaw = (value as { lastTouchedMs?: unknown }).lastTouchedMs;
  if (!isRecord(stepsRaw)) return null;
  if (!isFiniteNumber(lastTouchedRaw)) return null;

  // Preserve the device entry even when every persisted step record is
  // unusable; otherwise a partial corruption (one malformed step) would
  // silently drop *all* of the device's calibration history. Returning an
  // entry with an empty `steps` map lets the in-memory store keep tracking
  // freshness via `lastTouchedMs` while subsequent samples rebuild the EMA.
  const stepEntries = Object.entries(stepsRaw).flatMap(([stepId, stepRaw]) => {
    if (typeof stepId !== 'string' || stepId.length === 0) return [];
    const normalized = normalizeStepCalibration(stepRaw);
    return normalized ? [[stepId, normalized] as const] : [];
  });
  return { steps: Object.fromEntries(stepEntries), lastTouchedMs: lastTouchedRaw };
}

function normalizeStepCalibration(value: unknown): StepCalibration | null {
  if (!isPersistedStepShape(value)) return null;
  return {
    observedKw: value.observedKw,
    nameplateAtSampleKw: value.nameplateAtSampleKw,
    samples: value.samples,
    sustainedSeconds: value.sustainedSeconds,
    lastSampleMs: value.lastSampleMs,
  };
}

/**
 * Validate that `value` carries every field of a `StepCalibration` in the
 * shape the normaliser would accept. Used by both `normalizeStepCalibration`
 * (drop bad records) and `isPlausiblePersistedSnapshot` (engage load-grace
 * when *any* nested record is malformed) so the two paths stay in lockstep
 * — otherwise a payload whose nested records the normaliser silently drops
 * could still bypass the grace window.
 */
export function isPersistedStepShape(value: unknown): value is StepCalibration {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.observedKw) || value.observedKw < 0) return false;
  if (!isFiniteNumber(value.nameplateAtSampleKw) || value.nameplateAtSampleKw <= 0) return false;
  if (!isFiniteNumber(value.samples) || value.samples < 0) return false;
  if (!isFiniteNumber(value.sustainedSeconds) || value.sustainedSeconds < 0) return false;
  if (!isFiniteNumber(value.lastSampleMs)) return false;
  return true;
}

/**
 * Validate that `value` carries every field of a `DeviceCalibration` with all
 * nested step records also strictly valid. Used by
 * `isPlausiblePersistedSnapshot`; the corresponding normaliser is intentionally
 * more lenient (preserves the device entry when only a subset of steps are
 * malformed) but the plausibility check must reject *any* malformed nested
 * data to keep the grace window protective.
 */
export function isStrictlyValidPersistedDevice(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const v = value as { steps?: unknown; lastTouchedMs?: unknown };
  if (!isFiniteNumber(v.lastTouchedMs)) return false;
  if (!isRecord(v.steps)) return false;
  return Object.values(v.steps).every(isPersistedStepShape);
}

export const POWER_CALIBRATION_CONSTANTS = {
  MIN_ALPHA,
  MAX_ALPHA,
  CONFIDENCE_MIN_SAMPLES,
  CONFIDENCE_MIN_SUSTAINED_SECONDS,
  DEFAULT_FRESHNESS_WINDOW_MS,
  SUSTAINED_SECONDS_GAP_CAP_MS,
  NAMEPLATE_TOLERANCE_RATIO,
  ANOMALY_MULTIPLIER,
  RECENT_DRAW_DEFAULT_MIN_KW,
} as const;
