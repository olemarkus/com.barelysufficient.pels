import type { ObjectiveSampleDevice } from './samples';
import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './types';
import type { PowerTrackerState } from '../power/trackerTypes';
import { shouldEmitRejectedProfileSample } from './rejectionLogging';
import {
  isWithinEnergyPerUnitBand,
  resolveEnergyPerUnitBand,
  type EnergyPerUnitBand,
} from './energyBand';
import { applyBandedConfidence, resolveProfileConfidence, updateProfileStat } from './stats';
import { appendSampleToBuffer, fitBandsFromSamples, resolveKwhPerUnitStat } from './bands';
import { buildObjectiveProfileSample } from './samples';
import { emitObjectiveProfileNoPowerSourceIfNeeded } from './noPowerSourceDiagnostic';
import {
  CLEARED_ENERGY_ACCUMULATOR,
  calculateWindowEnergyKwh,
  resolveSubIntervalLeftEdge,
  subIntervalEnergyKwh,
} from './energyAccumulator';

export type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './types';

export const OBJECTIVE_PROFILE_MAX_DEVICES = 64;
export const OBJECTIVE_PROFILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const OBJECTIVE_PROFILE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const OBJECTIVE_PROFILE_MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
// One rise floor and one rate ceiling, on the value's own scale — this layer has
// no unit to pick between. The energy side has no constant here at all: what a
// window may cost per unit is the device's own learned band (`energyBand.ts`),
// because one fleet-wide number cannot tell a tank's ordinary heating from its
// refill and calls both plausible.
const MIN_VALUE_RISE = 0.2;
const MAX_UNIT_PER_HOUR = 100;

export type ObjectiveProfileDebugEmitter = (payload: Record<string, unknown>) => void;

/**
 * What a refusal does to the open baseline→sample window.
 *
 * `void` — the window itself is unusable, so the baseline moves to this sample
 *   and the partial energy sum is dropped. Anything less carries the refused
 *   energy forward: the sums are cumulative from `lastSample`, so keeping the
 *   baseline does not discard a bad window, it *defers* it into the next one. A
 *   refill of 2 kWh across 0.8 units, refused, followed by an ordinary 2 kWh
 *   across 4 units, arrives as 4 kWh across 4.8 units — 0.83 for a device whose
 *   rate is 0.5, comfortably inside its band and accepted. The contamination
 *   the band had just refused gets in through the following window.
 * `keep` — the refusal is about this SAMPLE, not the window: the window is still
 *   open and honest, and the next sample continues it across a longer interval.
 *   An interval too short to bill is the case that needs this — voiding there
 *   would restart the window on every 10 s poll and no window would ever reach
 *   the minimum interval. A non-monotonic sample needs it too, for a different
 *   reason: moving the baseline onto an out-of-order sample walks it backwards
 *   in time.
 */
type RejectedWindowDisposition = 'void' | 'keep';

/**
 * A refused candidate window: the reason code, what becomes of the open window,
 * and — for the energy verdict — the figure and the band it missed, so the
 * structured log says *what* was out of range and against *which* bound rather
 * than only that something was.
 *
 * The disposition travels with the reason because it is decided by the same
 * judgement. It used to be a list of reason strings read back at the far end,
 * which is a second place to remember a thing, and the energy verdict was
 * missing from that list.
 */
type ProfileSampleRejection = {
  reason: string;
  openWindow: RejectedWindowDisposition;
  energy?: { kwhPerUnit: number; band: EnergyPerUnitBand };
};

export function updateObjectiveProfilesFromSnapshot(params: {
  state: PowerTrackerState;
  devices: ObjectiveSampleDevice[];
  nowMs: number;
  debugStructured?: ObjectiveProfileDebugEmitter;
  outdoorTemperatureC?: number;
}): PowerTrackerState {
  const { state, devices, nowMs, debugStructured, outdoorTemperatureC } = params;
  const previousProfiles = state.objectiveProfiles ?? {};
  let nextProfiles: Record<string, DeviceObjectiveProfile> = previousProfiles;
  let changed = false;

  const ensureMutable = (): Record<string, DeviceObjectiveProfile> => {
    if (!changed) {
      nextProfiles = { ...previousProfiles };
      changed = true;
    }
    return nextProfiles;
  };

  for (const device of devices) {
    const sample = buildObjectiveProfileSample(device, nowMs);
    if (!sample) continue;

    const previous = previousProfiles[device.id];
    const next = updateDeviceObjectiveProfile({
      previous,
      sample,
      deviceId: device.id,
      deviceName: device.name,
      debugStructured,
      outdoorTemperatureC,
    });
    if (next !== previous) {
      ensureMutable()[device.id] = next;
    }
  }

  if (
    changed
    || hasTooManyObjectiveProfiles(previousProfiles)
    || hasExpiredObjectiveProfiles(previousProfiles, nowMs)
  ) {
    const pruned = pruneObjectiveProfiles({
      profiles: nextProfiles,
      activeDeviceIds: new Set(devices.map((device) => device.id)),
      nowMs,
    });
    if (pruned !== nextProfiles) {
      nextProfiles = pruned;
      changed = true;
      debugStructured?.({
        event: 'objective_profile_pruned',
        retainedDeviceCount: Object.keys(nextProfiles).length,
      });
    }
  }

  return changed ? { ...state, objectiveProfiles: nextProfiles } : state;
}

export function updateDeviceObjectiveProfile(params: {
  previous?: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
  deviceId?: string;
  deviceName?: string;
  debugStructured?: ObjectiveProfileDebugEmitter;
  outdoorTemperatureC?: number;
}): DeviceObjectiveProfile {
  const { previous, sample, deviceId, deviceName, debugStructured, outdoorTemperatureC } = params;
  if (!previous) return buildInitialProfile(sample);

  const previousSample = previous.lastSample;
  const intervalMs = getProfileIntervalMs(previousSample, sample);
  const valueDelta = getProfileValueDelta(previousSample, sample);

  // Timing checks (non-monotonic time, too-short/too-long intervals) run first:
  // a stale or out-of-order sample has no window to bill energy across, so it
  // must never reach the value or energy verdicts, let alone reset the baseline.
  const intervalRejection = resolveProfileIntervalRejection({
    previousSample,
    sample,
    intervalMs,
  });
  if (intervalRejection) {
    // `resolveLastFreshDataMs` in `device/transport/managerParseSnapshot.ts`
    // takes `Math.max(...)` over multiple capability `lastUpdated` timestamps,
    // so an unrelated capability emitting a fresh update can rebuild the
    // snapshot with the *same* `value` and either an unchanged `observedAtMs`
    // (exact duplicate) or one a few ms lower (a previous capability ageing
    // out of the `Math.max` floor). Those duplicates carry no learning signal
    // and would otherwise burn the per-device rejection-throttle window on
    // real same-reason rejections, so silently drop them: no event, no
    // `rejectedSamples` increment. Other intervalRejection reasons (and any
    // non-monotonic sample whose value *did* change) still flow through the
    // normal rejection path.
    if (intervalRejection.reason === 'objective_profile_non_monotonic_time'
      && sample.value === previousSample.value) return previous;
    emitRejectedProfileSample({
      deviceId,
      deviceName,
      debugStructured,
      intervalMs,
      valueDelta,
      rejection: intervalRejection,
    });
    return buildRejectedProfileSample({
      previous,
      sample,
      rejection: intervalRejection,
    });
  }

  // Energy across the open baseline→sample window, accumulated per sub-interval
  // at each one's own left-edge power. Computed once and threaded into both the
  // energy-range rejection check and the accepted-sample builder so the verdict
  // and the recorded value rest on the same figure.
  const windowEnergyKwh = calculateWindowEnergyKwh(previous, sample);

  const rejection = resolveProfileValueOrEnergyRejection(
    previous,
    sample.observedAtMs,
    intervalMs,
    valueDelta,
    windowEnergyKwh,
  );
  // `rise_too_small` is the documented poisoning vector: a still-powered sample
  // whose value barely moved. Instead of discarding it (which billed the eventual
  // accepted rise at a single baseline power), close its sub-interval into the
  // accumulator and keep the baseline so the next real rise integrates the true
  // per-step power profile.
  if (rejection?.reason === 'objective_profile_rise_too_small') {
    emitRejectedProfileSample({
      deviceId, deviceName, debugStructured, intervalMs, valueDelta, rejection,
    });
    return accrueSubIntervalSkip({ previous, sample });
  }
  if (rejection) {
    emitRejectedProfileSample({
      deviceId,
      deviceName,
      debugStructured,
      intervalMs,
      valueDelta,
      rejection,
    });
    return buildRejectedProfileSample({
      previous,
      sample,
      rejection,
    });
  }

  return buildAcceptedProfileSample({
    previous,
    sample,
    deviceId,
    deviceName,
    debugStructured,
    intervalMs,
    valueDelta,
    windowEnergyKwh,
    outdoorTemperatureC,
  });
}

// `rise_too_small` skip: close the open sub-interval at its left-edge power into
// `pendingEnergyKWh`, advance the sub-interval pointer to this sample, and keep
// the baseline (`lastSample`) so the value delta still measures the full rise.
// A sub-interval whose left-edge power is absent or non-positive is thermally
// contaminated (the device coasted, not heated electrically) — discard the
// partial window and reset the baseline to this sample instead of averaging
// coast drift into the energy estimate.
function accrueSubIntervalSkip(params: {
  previous: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
}): DeviceObjectiveProfile {
  const { previous, sample } = params;
  const { fromMs, powerW } = resolveSubIntervalLeftEdge(previous);
  if (typeof powerW !== 'number' || powerW <= 0) {
    return {
      ...previous,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
      ...CLEARED_ENERGY_ACCUMULATOR,
    };
  }
  return {
    ...previous,
    updatedAtMs: sample.observedAtMs,
    rejectedSamples: previous.rejectedSamples + 1,
    pendingEnergyKWh: (previous.pendingEnergyKWh ?? 0)
      + subIntervalEnergyKwh(powerW, fromMs, sample.observedAtMs),
    subIntervalStartMs: sample.observedAtMs,
    subIntervalPowerW: sample.crediblePowerW,
  };
}

function buildAcceptedProfileSample(params: {
  previous: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
  deviceId?: string;
  deviceName?: string;
  debugStructured?: ObjectiveProfileDebugEmitter;
  intervalMs: number;
  valueDelta: number;
  windowEnergyKwh: number | undefined;
  outdoorTemperatureC?: number;
}): DeviceObjectiveProfile {
  const {
    previous, sample, deviceId, deviceName, debugStructured,
    intervalMs, valueDelta, windowEnergyKwh, outdoorTemperatureC,
  } = params;
  const previousSample = previous.lastSample;
  const unitPerHour = calculateUnitPerHour({ intervalMs, valueDelta });
  const energyKwh = windowEnergyKwh;
  const kwhPerUnit = energyKwh !== undefined ? calculateKwhPerUnit({ energyKwh, valueDelta }) : undefined;
  const learnedRateUpdate = resolveLearnedRateUpdate({
    previous, previousSample, sample, kwhPerUnit, outdoorTemperatureC,
  });
  const nextProfile = {
    ...previous,
    updatedAtMs: sample.observedAtMs,
    lastSample: sample,
    acceptedSamples: previous.acceptedSamples + 1,
    unitPerHour: updateProfileStat(previous.unitPerHour, unitPerHour, sample.observedAtMs),
    // `kwhPerUnit` arrives inside the update, derived from the same buffer the
    // bands are fitted from, rather than accumulated separately here.
    ...learnedRateUpdate,
    // The accepted rise closes the window; the next sample starts a fresh one
    // measured from this baseline.
    ...CLEARED_ENERGY_ACCUMULATOR,
  };
  // Snapshot the raw-CV (global) confidence *before* `applyBandedConfidence`
  // overrides `kwhPerUnit.confidence`, so `globalEnergyConfidence` below
  // stays comparable with pre-Step-2 log dumps for the same device.
  const globalEnergyConfidence = nextProfile.kwhPerUnit
    ? resolveProfileConfidence(nextProfile.kwhPerUnit)
    : null;
  // Once the bands are merged in, re-resolve the overall kWh/unit confidence
  // against the pooled within-band residual (Step 2 of the banded-confidence
  // fix). The plain `updateProfileStat` above used the global `m2`,
  // which on multi-step devices is inflated by between-step spread and pins
  // confidence at `low` even when each step's rate has converged tightly.
  // Per-band confidences are unchanged.
  nextProfile.kwhPerUnit = applyBandedConfidence(nextProfile.kwhPerUnit, nextProfile.bands);
  // `energyConfidence` reflects banded data when bands have fit (best-available
  // signal); `globalEnergyConfidence` always carries the raw-CV value so
  // old/new log dumps stay directly comparable across the Step-2 cutover.
  debugStructured?.({
    event: 'objective_profile_sample_recorded',
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    intervalMs,
    valueDelta,
    unitPerHour,
    kwhPerUnit: kwhPerUnit ?? null,
    energyKwh: energyKwh ?? null,
    acceptedSamples: nextProfile.acceptedSamples,
    rateConfidence: nextProfile.unitPerHour.confidence,
    energyConfidence: nextProfile.kwhPerUnit?.confidence ?? null,
    globalEnergyConfidence,
    powerSource: previousSample.powerSource ?? null,
    // Also `kwhPerUnit.sampleCount` now, since the stat is derived from this
    // same buffer — one number, logged once.
    bufferedSamples: nextProfile.samples?.length ?? 0,
    bandsCount: nextProfile.bands?.length ?? 0,
  });
  emitObjectiveProfileNoPowerSourceIfNeeded({
    deviceId, deviceName, sample, debugStructured,
    acceptedSamples: nextProfile.acceptedSamples,
  });
  return nextProfile;
}

function buildRejectedProfileSample(params: {
  previous: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
  rejection: ProfileSampleRejection;
}): DeviceObjectiveProfile {
  const { previous, sample, rejection } = params;
  if (rejection.openWindow === 'void') {
    return {
      ...previous,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
      // Baseline reset → the open energy window is void; drop the partial sum.
      // Both halves are required: keeping either the baseline or the partial sum
      // carries the refused window into the next one.
      ...CLEARED_ENERGY_ACCUMULATOR,
    };
  }
  return {
    ...previous,
    rejectedSamples: previous.rejectedSamples + 1,
  };
}

function emitRejectedProfileSample(params: {
  deviceId?: string;
  deviceName?: string;
  debugStructured?: ObjectiveProfileDebugEmitter;
  intervalMs: number;
  valueDelta: number;
  rejection: ProfileSampleRejection;
}): void {
  const {
    deviceId,
    deviceName,
    debugStructured,
    intervalMs,
    valueDelta,
    rejection,
  } = params;
  const rejectionReason = rejection.reason;
  if (!shouldEmitRejectedProfileSample({ deviceId, rejectionReason })) return;
  debugStructured?.({
    event: 'objective_profile_sample_rejected',
    reasonCode: rejectionReason,
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    intervalMs,
    valueDelta,
    // An energy verdict is uninterpretable without the band it missed: the same
    // reason code means "above a fleet-wide bootstrap bound" on a young profile
    // and "outside what this device has ever needed" on a grown one.
    ...(rejection.energy
      ? {
        kwhPerUnit: rejection.energy.kwhPerUnit,
        bandBasis: rejection.energy.band.basis,
        bandLowerKwhPerUnit: rejection.energy.band.lowerKwhPerUnit,
        bandUpperKwhPerUnit: rejection.energy.band.upperKwhPerUnit,
      }
      : {}),
  });
}

function resolveProfileValueOrEnergyRejection(
  previous: DeviceObjectiveProfile,
  observedAtMs: number,
  intervalMs: number,
  valueDelta: number,
  windowEnergyKwh: number | undefined,
): ProfileSampleRejection | null {
  return resolveProfileValueRejection(intervalMs, valueDelta)
    ?? resolveProfileEnergyRejection(previous, observedAtMs, valueDelta, windowEnergyKwh);
}

function resolveProfileIntervalRejection(params: {
  previousSample: DeviceObjectiveProfileSample;
  sample: DeviceObjectiveProfileSample;
  intervalMs: number;
}): ProfileSampleRejection | null {
  const { previousSample, sample, intervalMs } = params;
  // Out of order: the baseline must not follow this sample backwards in time.
  if (sample.observedAtMs <= previousSample.observedAtMs) {
    return { reason: 'objective_profile_non_monotonic_time', openWindow: 'keep' };
  }
  // Too soon to bill, but the window is honest and still open — it just needs
  // longer. Voiding here would restart it on every poll.
  if (intervalMs < OBJECTIVE_PROFILE_MIN_INTERVAL_MS) {
    return { reason: 'objective_profile_interval_too_short', openWindow: 'keep' };
  }
  if (intervalMs > OBJECTIVE_PROFILE_MAX_INTERVAL_MS) {
    return { reason: 'objective_profile_interval_too_long', openWindow: 'void' };
  }
  return null;
}

function resolveProfileValueRejection(
  intervalMs: number,
  valueDelta: number,
): ProfileSampleRejection | null {
  if (valueDelta < MIN_VALUE_RISE) {
    // A rise too small to bill keeps the window: the caller banks its
    // sub-interval into the accumulator instead (`accrueSubIntervalSkip`), which
    // is the whole point of that path. A fall voids it — the next accepted rise
    // must be measured against the new low, not a stale pre-drop value.
    return valueDelta >= 0
      ? { reason: 'objective_profile_rise_too_small', openWindow: 'keep' }
      : { reason: 'objective_profile_value_fell', openWindow: 'void' };
  }
  const unitPerHour = calculateUnitPerHour({ intervalMs, valueDelta });
  if (!Number.isFinite(unitPerHour) || unitPerHour <= 0 || unitPerHour > MAX_UNIT_PER_HOUR) {
    // A value that moved faster than anything physical is junk, and carrying the
    // window forward keeps that jump in every later delta until the interval cap
    // finally resets it.
    return { reason: 'objective_profile_rate_out_of_range', openWindow: 'void' };
  }
  return null;
}

/**
 * The one contamination test. A window that cost far more or far less energy per
 * unit than this device has ever needed did not measure ordinary operation — a
 * tank refilling with cold water, a charge report that stepped, a room bleeding
 * heat out of an open door — and folding it in poisons every smart task sized
 * from the rate afterwards. The verdict is the device's own band; no cause is
 * diagnosed and none needs to be. `energyBand.ts` carries the reasoning.
 */
function resolveProfileEnergyRejection(
  previous: DeviceObjectiveProfile,
  observedAtMs: number,
  valueDelta: number,
  windowEnergyKwh: number | undefined,
): ProfileSampleRejection | null {
  // No credible power across the window (device idle / coasting) → no energy
  // estimate to range-check; the sample can still be accepted on its value rise
  // and simply contributes no `kwhPerUnit`.
  if (windowEnergyKwh === undefined) return null;
  const kwhPerUnit = calculateKwhPerUnit({ energyKwh: windowEnergyKwh, valueDelta });
  const band = resolveEnergyPerUnitBand(previous, observedAtMs);
  if (
    !Number.isFinite(kwhPerUnit)
    || kwhPerUnit <= 0
    || !isWithinEnergyPerUnitBand(band, kwhPerUnit)
  ) {
    return {
      reason: 'objective_profile_energy_per_unit_out_of_range',
      // Void, and this is load-bearing: the energy and the value delta are both
      // cumulative from the baseline, so a refusal that keeps the window hands
      // the refused energy to the next sample rather than discarding it.
      openWindow: 'void',
      energy: { kwhPerUnit, band },
    };
  }
  return null;
}

function getProfileIntervalMs(prev: DeviceObjectiveProfileSample, s: DeviceObjectiveProfileSample): number {
  return s.observedAtMs - prev.observedAtMs;
}

function getProfileValueDelta(prev: DeviceObjectiveProfileSample, s: DeviceObjectiveProfileSample): number {
  return s.value - prev.value;
}

function calculateUnitPerHour(params: { intervalMs: number; valueDelta: number }): number {
  return params.valueDelta / (params.intervalMs / 3_600_000);
}

function calculateKwhPerUnit(params: { energyKwh: number; valueDelta: number }): number {
  return params.energyKwh / params.valueDelta;
}

// Everything the profile knows about its kWh/unit rate, rebuilt from one
// buffer: the observation goes into the per-device ring buffer, and the band
// layout and the global statistic are both derived from what that buffer then
// holds. Deriving rather than accumulating is what lets the buffer's horizon
// reach the statistic — a running Welford pair cannot have an aged-out window
// taken back out of it, and `resolveProfileEnergy` sizes every smart task from
// that statistic. Returning a partial Pick lets the caller spread the update
// inline without branching twice on whether kWh/unit is known.
function resolveLearnedRateUpdate(params: {
  previous: DeviceObjectiveProfile;
  previousSample: DeviceObjectiveProfileSample;
  sample: DeviceObjectiveProfileSample;
  kwhPerUnit: number | undefined;
  outdoorTemperatureC?: number;
}): Partial<Pick<DeviceObjectiveProfile, 'samples' | 'bands' | 'kwhPerUnit'>> {
  const { previous, previousSample, sample, kwhPerUnit, outdoorTemperatureC } = params;
  if (kwhPerUnit === undefined) return {};
  // Tag the sample by the midpoint of the rise so the band layout reflects
  // where the energy was actually deposited, not just the end value.
  const inputValue = (previousSample.value + sample.value) / 2;
  const samples = appendSampleToBuffer(previous.samples, {
    observedAtMs: sample.observedAtMs,
    inputValue,
    kwhPerUnit,
    ...(outdoorTemperatureC !== undefined ? { outdoorTemperatureC } : {}),
  });
  const bands = fitBandsFromSamples({ samples });
  // Explicit `bands: undefined` clears any prior layout if the fitter declines
  // to publish one (e.g., the buffer dipped under the split threshold). The
  // undefined key is dropped when the tracker store serialises the profiles.
  return { samples, bands, kwhPerUnit: resolveKwhPerUnitStat(samples, sample.observedAtMs) };
}

function buildInitialProfile(sample: DeviceObjectiveProfileSample): DeviceObjectiveProfile {
  return {
    updatedAtMs: sample.observedAtMs,
    lastSample: sample,
    acceptedSamples: 0,
    rejectedSamples: 0,
  };
}


function pruneObjectiveProfiles(params: {
  profiles: Record<string, DeviceObjectiveProfile>;
  activeDeviceIds: Set<string>;
  nowMs: number;
}): Record<string, DeviceObjectiveProfile> {
  const entries = Object.entries(params.profiles)
    .filter(([deviceId, profile]) => (
      params.activeDeviceIds.has(deviceId)
      || params.nowMs - profile.updatedAtMs <= OBJECTIVE_PROFILE_RETENTION_MS
    ));
  if (
    entries.length === Object.keys(params.profiles).length
    && entries.length <= OBJECTIVE_PROFILE_MAX_DEVICES
  ) {
    return params.profiles;
  }
  if (entries.length <= OBJECTIVE_PROFILE_MAX_DEVICES) {
    return Object.fromEntries(entries);
  }
  const sortedEntries = entries.sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs);
  return Object.fromEntries(sortedEntries.slice(0, OBJECTIVE_PROFILE_MAX_DEVICES));
}

function hasTooManyObjectiveProfiles(
  profiles: Record<string, DeviceObjectiveProfile>,
): boolean {
  return Object.keys(profiles).length > OBJECTIVE_PROFILE_MAX_DEVICES;
}

function hasExpiredObjectiveProfiles(
  profiles: Record<string, DeviceObjectiveProfile>,
  nowMs: number,
): boolean {
  return Object.values(profiles)
    .some((profile) => nowMs - profile.updatedAtMs > OBJECTIVE_PROFILE_RETENTION_MS);
}
