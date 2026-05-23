/**
 * Idle-state classification for devices commanded on but drawing ~0 W.
 * Output is consumed by the Settings UI and structured logs only — the
 * planner already treats `measuredPowerKw = 0` correctly via
 * `getCurrentDrawKw`, so this module does not feed back into plan or restore
 * accounting.
 *
 * Three distinct states are produced:
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
 *  - `capped_idle`: device is well below the PELS-commanded target but its
 *    own thermostat / internal setpoint cap has opened — temperature parks
 *    at a stable plateau several degrees below target while power *cycles*
 *    around the device's own anti-cycle hysteresis. The Connected 300
 *    water heater at a ~60 °C internal cap with a 65 °C PELS target is the
 *    canonical case. Distinct from `unresponsive` because the heater is
 *    actually heating (just not as far as PELS asked), and distinct from
 *    `near_target_idle` because the gap is wider than the hysteresis band.
 *    Surfaced as a neutral status line — the device is behaving correctly
 *    against its own cap, so no warning chip.
 *
 * Eligibility gates are evaluated inside this module
 * (`passesCommonEligibility` for the basic temperature-device shape;
 * `measuredIsIdle` for the existing two states; `shouldUseCappedIdle` for
 * the cycling case). Callers populate `pelsCommandedShed` from the plan
 * snapshot's `shedAction` so the detector never reports on a device PELS
 * itself is suppressing — the gate is the detector's responsibility, not
 * the caller's.
 *
 * Only temperature-bearing devices are eligible: without a setpoint reading
 * we have no way to distinguish "satisfied hold" from "broken" / "capped".
 * EV chargers have their own pause modelling (`ev_pause`) and are excluded.
 */
import { isFiniteNumber } from '../utils/appTypeGuards';

export type IdleClassification =
  | 'active'
  | 'near_target_idle'
  | 'unresponsive'
  | 'capped_idle';

export const IDLE_MEASURED_POWER_THRESHOLD_KW = 0.05;
export const IDLE_HOLD_MIN_DURATION_MS = 5 * 60 * 1000;
export const IDLE_UNRESPONSIVE_MIN_DURATION_MS = 15 * 60 * 1000;
export const NEAR_TARGET_TEMPERATURE_DELTA_C = 5;
export const NEAR_TARGET_TEMPERATURE_EXIT_DELTA_C = 5.5;

// Window over which power cycling and temperature stability are evaluated
// for `capped_idle`. 20 min comfortably exceeds the typical Connected 300
// thermostat duty cycle (a few minutes on / several minutes off) so both
// halves of the cycle land inside the window, while staying short enough
// that a real false-missed run gets re-classified before the user gives up
// reading the "device unresponsive" misdiagnosis.
export const CAPPED_IDLE_MIN_WINDOW_MS = 20 * 60 * 1000;

// Maximum temperature spread (°C) tolerated inside the window for the
// device to read as a stable plateau. The Connected 300 parks at ~61.5 °C
// with sub-degree drift; a heater that is genuinely climbing toward target
// (rate-limited charging) will exceed this and stay `active` instead.
export const CAPPED_IDLE_MAX_TEMPERATURE_SPREAD_C = 1.0;

// Hard cap on retained samples per device. At a 10 s plan tick (the home
// case) ~120 samples covers the 20-min window; we keep some headroom for
// slower / irregular tick cadences (e.g. flow-driven power) without
// unbounded growth. Old samples outside the window are pruned each call.
const SAMPLE_HISTORY_MAX = 200;

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

// Rolling sample retained per device so the cycling detector can look back
// across the `CAPPED_IDLE_MIN_WINDOW_MS` window. Power and temperature are
// optional independently — a tick that drops one reading still anchors the
// other in the window so future ticks can complete the picture.
type IdleSample = {
  atMs: number;
  powerKw: number | undefined;
  temperatureC: number | undefined;
};

export type IdleDetectorEntry = {
  /**
   * Start of the current measured-idle streak. Reset (entry removed) when
   * the device draws power or any eligibility precondition fails.
   */
  idleSinceMs: number;
  lastClassification: IdleClassification;
  /**
   * Rolling window of recent samples used to evaluate `capped_idle`.
   * Independent of the `idleSinceMs` streak — cycling devices reset that
   * streak, but we still want to see their history. Pruned to entries
   * inside `CAPPED_IDLE_MIN_WINDOW_MS` on each classification call.
   */
  samples: IdleSample[];
  /**
   * Timestamp of the first sample ever recorded for this device session
   * (i.e. since the last eligibility break). Used to gate `capped_idle`
   * on full window coverage — the samples buffer alone can't answer that
   * once pruning has discarded the original oldest sample.
   */
  firstSampleAtMs: number;
};

export type IdleDetectorState = Map<string, IdleDetectorEntry>;

export type IdleDetectorResult = {
  classification: IdleClassification;
  /** Previous classification — undefined when the device has no prior entry. */
  previousClassification?: IdleClassification;
  /**
   * Milliseconds of continuous idle in the current streak. Preserved across
   * the active-transition so the cleared-event payload can report how long
   * the device was actually held before resuming. Zero for `capped_idle`
   * because the cycling pattern keeps the idle streak from accumulating.
   */
  idleDurationMs: number;
  /** Current vs target gap when both are known; undefined otherwise. */
  temperatureGapC?: number;
};

const measuredIsIdle = (kw: number | undefined): boolean => (
  isFiniteNumber(kw) && kw >= 0 && kw <= IDLE_MEASURED_POWER_THRESHOLD_KW
);

const measuredIsDrawing = (kw: number | undefined): boolean => (
  isFiniteNumber(kw) && kw > IDLE_MEASURED_POWER_THRESHOLD_KW
);

const computeTemperatureGap = (
  current: number | undefined,
  target: number | undefined,
): number | undefined => {
  if (!isFiniteNumber(current) || !isFiniteNumber(target)) return undefined;
  return target - current;
};

// Common shape applies to both the near-target / unresponsive paths and the
// `capped_idle` cycling path — the device must be a non-EV temperature
// device, observation must be trustworthy, the device must report itself on,
// and PELS must not be the reason it's not drawing. The narrower
// "currently idle" gate stays at the `measuredIsIdle` call sites only —
// `capped_idle` deliberately accepts both on- and off-cycle ticks so the
// cycling discriminator can see both halves of the device's duty cycle.
const passesCommonEligibility = (input: IdleDetectorInput): boolean => {
  if (input.isEvCharger) return false;
  if (!input.hasTemperatureSetpoint) return false;
  if (input.observationStale === true) return false;
  if (!input.observedOn) return false;
  if (input.pelsCommandedShed) return false;
  return true;
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

const pruneSamplesToWindow = (
  samples: readonly IdleSample[],
  now: number,
): IdleSample[] => {
  const cutoff = now - CAPPED_IDLE_MIN_WINDOW_MS;
  const trimmed = samples.filter((sample) => sample.atMs >= cutoff);
  // Defensive cap — irregular tick cadences (flow-driven power) could
  // otherwise grow the buffer without bound on a device the window never
  // empties for. Keeps the newest entries.
  if (trimmed.length > SAMPLE_HISTORY_MAX) {
    return trimmed.slice(trimmed.length - SAMPLE_HISTORY_MAX);
  }
  return trimmed;
};

const appendSample = (
  samples: readonly IdleSample[],
  next: IdleSample,
  now: number,
): IdleSample[] => [...pruneSamplesToWindow(samples, now), next];

// True when the recorded power samples span both the drawing and the idle
// state inside the window AND drawing samples appear in *both halves* of
// the window — the genuine cycling signature that distinguishes a device
// respecting its own internal cap from one that has gone dark.
//
// The two-halves requirement guards against the "one brief on-burst then
// silence" shape (e.g. a tripped breaker mid-burst, child-lock engaged
// mid-cycle). A water heater with 200L of thermal mass loses well under
// 1 °C in 20 min even with the heater fully off, so the stable-temperature
// check alone is not enough to distinguish a real cycling device from a
// device that drew once and then went dark. Requiring drawing samples in
// both halves of the window means a single transient burst can't promote
// to `capped_idle` and silently call a stuck device "succeeded" — that's
// the failure mode `unresponsive → null` was designed to prevent.
const samplesShowCycling = (
  samples: readonly IdleSample[],
  windowEndMs: number,
): boolean => {
  if (samples.length === 0) return false;
  const windowStartMs = windowEndMs - CAPPED_IDLE_MIN_WINDOW_MS;
  const halfMs = windowStartMs + CAPPED_IDLE_MIN_WINDOW_MS / 2;
  let sawDrawingFirstHalf = false;
  let sawDrawingSecondHalf = false;
  let sawIdle = false;
  for (const sample of samples) {
    if (measuredIsDrawing(sample.powerKw)) {
      if (sample.atMs < halfMs) sawDrawingFirstHalf = true;
      else sawDrawingSecondHalf = true;
    } else if (measuredIsIdle(sample.powerKw)) {
      sawIdle = true;
    }
  }
  return sawDrawingFirstHalf && sawDrawingSecondHalf && sawIdle;
};

// True when temperature readings inside the window stay within a narrow
// band — the "stuck at the device's own cap" signature. An undefined
// reading is ignored so a single missing tick doesn't flip the result.
const samplesShowStableTemperature = (samples: readonly IdleSample[]): boolean => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const sample of samples) {
    if (!isFiniteNumber(sample.temperatureC)) continue;
    if (sample.temperatureC < min) min = sample.temperatureC;
    if (sample.temperatureC > max) max = sample.temperatureC;
    count += 1;
  }
  if (count < 2) return false;
  return max - min <= CAPPED_IDLE_MAX_TEMPERATURE_SPREAD_C;
};

// True when the device has been observed continuously for at least the
// full window. `firstSampleAtMs` is the un-pruned timestamp of the first
// sample we recorded for the current session — once the buffer prunes
// earlier samples, `samples[0]!.atMs` reads as more recent than the true
// session start, so we track the session start separately. Prevents
// `capped_idle` from firing on a half-populated window during the first
// ticks after a restart or eligibility break.
const hasObservedFullWindow = (
  firstSampleAtMs: number | undefined,
  now: number,
): boolean => {
  if (firstSampleAtMs === undefined) return false;
  return now - firstSampleAtMs >= CAPPED_IDLE_MIN_WINDOW_MS;
};

// `capped_idle` overrides only the cases where the existing two-state
// machine would have returned `active` or `unresponsive` — the underlying
// truth being measured is "the device has settled at its own cap, not at
// PELS' commanded target". A `near_target_idle` device is already on the
// right side of the hysteresis band so we never override it.
const shouldUseCappedIdle = (params: {
  gap: number | undefined;
  samples: readonly IdleSample[];
  firstSampleAtMs: number | undefined;
  now: number;
}): boolean => {
  if (params.gap === undefined) return false;
  if (params.gap <= NEAR_TARGET_TEMPERATURE_DELTA_C) return false;
  if (!hasObservedFullWindow(params.firstSampleAtMs, params.now)) return false;
  if (!samplesShowCycling(params.samples, params.now)) return false;
  if (!samplesShowStableTemperature(params.samples)) return false;
  return true;
};

const elapsedSince = (previousEntry: IdleDetectorEntry | undefined, now: number): number => (
  previousEntry ? Math.max(0, now - previousEntry.idleSinceMs) : 0
);

// Bundled context the per-branch result builders share — pulling these into
// a single record keeps each builder under the max-params budget while still
// reading naturally at each call site.
type ClassifyContext = {
  state: IdleDetectorState;
  input: IdleDetectorInput;
  previousEntry: IdleDetectorEntry | undefined;
  previousClassification: IdleClassification | undefined;
  samples: IdleSample[];
  firstSampleAtMs: number;
  gap: number | undefined;
};

// Common-eligibility break — purge the streak entry and report "active"
// with the just-lost duration so the cleared-event payload stays honest.
const buildIneligibleResult = (
  state: IdleDetectorState,
  input: IdleDetectorInput,
  previousEntry: IdleDetectorEntry | undefined,
  previousClassification: IdleClassification | undefined,
  gap: number | undefined,
): IdleDetectorResult => {
  const idleDurationMs = elapsedSince(previousEntry, input.now);
  if (previousEntry) state.delete(input.deviceId);
  return {
    classification: 'active',
    previousClassification,
    idleDurationMs,
    temperatureGapC: gap,
  };
};

// Device is drawing power and doesn't match the cycling pattern — close
// the idle streak but keep accumulating samples for the next window check.
const buildDrawingActiveResult = (ctx: ClassifyContext): IdleDetectorResult => {
  const idleDurationMs = elapsedSince(ctx.previousEntry, ctx.input.now);
  ctx.state.set(ctx.input.deviceId, {
    idleSinceMs: ctx.input.now,
    lastClassification: 'active',
    samples: ctx.samples,
    firstSampleAtMs: ctx.firstSampleAtMs,
  });
  return {
    classification: 'active',
    previousClassification: ctx.previousClassification,
    idleDurationMs,
    temperatureGapC: ctx.gap,
  };
};

// Capped-idle wins over the measured-idle path because cycling history is
// the more specific signal — an unresponsive device would have no
// on-cycles in the window. Streak start is the now-moment — `capped_idle`
// doesn't accumulate a contiguous idle streak by definition, so reporting
// zero duration is the honest answer.
const buildCappedIdleResult = (ctx: ClassifyContext): IdleDetectorResult => {
  ctx.state.set(ctx.input.deviceId, {
    idleSinceMs: ctx.input.now,
    lastClassification: 'capped_idle',
    samples: ctx.samples,
    firstSampleAtMs: ctx.firstSampleAtMs,
  });
  return {
    classification: 'capped_idle',
    previousClassification: ctx.previousClassification,
    idleDurationMs: 0,
    temperatureGapC: ctx.gap,
  };
};

const buildMeasuredIdleResult = (ctx: ClassifyContext): IdleDetectorResult => {
  const idleSinceMs = ctx.previousEntry?.idleSinceMs ?? ctx.input.now;
  const idleDurationMs = Math.max(0, ctx.input.now - idleSinceMs);
  const classification = classifyByGapAndDuration(ctx.gap, idleDurationMs, ctx.previousClassification);
  ctx.state.set(ctx.input.deviceId, {
    idleSinceMs,
    lastClassification: classification,
    samples: ctx.samples,
    firstSampleAtMs: ctx.firstSampleAtMs,
  });
  return {
    classification,
    previousClassification: ctx.previousClassification,
    idleDurationMs,
    temperatureGapC: ctx.gap,
  };
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
  const gap = computeTemperatureGap(input.currentTemperature, input.targetTemperature);

  if (!passesCommonEligibility(input)) {
    return buildIneligibleResult(state, input, previousEntry, previousClassification, gap);
  }

  // Common eligibility holds — record the sample (regardless of
  // on/off-cycle) so the cycling discriminator can see both halves of
  // the device's duty cycle. `firstSampleAtMs` is sticky across the
  // current session so window coverage survives buffer pruning.
  const samples = appendSample(previousEntry?.samples ?? [], {
    atMs: input.now,
    powerKw: input.measuredPowerKw,
    temperatureC: input.currentTemperature,
  }, input.now);
  const firstSampleAtMs = previousEntry?.firstSampleAtMs ?? input.now;
  const ctx: ClassifyContext = {
    state, input, previousEntry, previousClassification, samples, firstSampleAtMs, gap,
  };

  if (shouldUseCappedIdle({ gap, samples, firstSampleAtMs, now: input.now })) {
    return buildCappedIdleResult(ctx);
  }
  if (!measuredIsIdle(input.measuredPowerKw)) {
    return buildDrawingActiveResult(ctx);
  }
  return buildMeasuredIdleResult(ctx);
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
