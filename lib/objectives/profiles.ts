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
import { appendSampleToBuffer, fitBandsFromSamples } from './bands';
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
 * A refused candidate window: the reason code, plus — for the energy verdict —
 * the figure and the band it missed, so the structured log says *what* was out
 * of range and against *which* bound rather than only that something was.
 */
type ProfileSampleRejection = {
  reason: string;
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
  const intervalRejection = resolveProfileIntervalRejectionReason({
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
    if (intervalRejection === 'objective_profile_non_monotonic_time'
      && sample.value === previousSample.value) return previous;
    emitRejectedProfileSample({
      deviceId,
      deviceName,
      debugStructured,
      intervalMs,
      valueDelta,
      rejection: { reason: intervalRejection },
    });
    return buildRejectedProfileSample({
      previous,
      sample,
      rejectionReason: intervalRejection,
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
      rejectionReason: rejection.reason,
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
  const bandedUpdate = resolveBandedUpdate({
    previous, previousSample, sample, kwhPerUnit, outdoorTemperatureC,
  });
  const nextProfile = {
    ...previous,
    updatedAtMs: sample.observedAtMs,
    lastSample: sample,
    acceptedSamples: previous.acceptedSamples + 1,
    unitPerHour: updateProfileStat(previous.unitPerHour, unitPerHour, sample.observedAtMs),
    ...(kwhPerUnit !== undefined
      ? { kwhPerUnit: updateProfileStat(previous.kwhPerUnit, kwhPerUnit, sample.observedAtMs) }
      : {}),
    ...bandedUpdate,
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
  rejectionReason: string;
}): DeviceObjectiveProfile {
  const { previous, sample, rejectionReason } = params;
  if (
    rejectionReason === 'objective_profile_interval_too_long'
    // Small falls below the sharp-fall threshold still need a fresh baseline so
    // the next accepted rise is measured against the new low — otherwise the
    // delta is computed against a stale pre-drop value and inflates kWh/unit.
    || rejectionReason === 'objective_profile_value_fell'
  ) {
    return {
      ...previous,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
      // Baseline reset → the open energy window is void; drop the partial sum.
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
  const valueReason = resolveProfileValueRejectionReason(intervalMs, valueDelta);
  if (valueReason) return { reason: valueReason };
  return resolveProfileEnergyRejection(previous, observedAtMs, valueDelta, windowEnergyKwh);
}

function resolveProfileIntervalRejectionReason(params: {
  previousSample: DeviceObjectiveProfileSample;
  sample: DeviceObjectiveProfileSample;
  intervalMs: number;
}): string | null {
  const { previousSample, sample, intervalMs } = params;
  if (sample.observedAtMs <= previousSample.observedAtMs) return 'objective_profile_non_monotonic_time';
  if (intervalMs < OBJECTIVE_PROFILE_MIN_INTERVAL_MS) return 'objective_profile_interval_too_short';
  if (intervalMs > OBJECTIVE_PROFILE_MAX_INTERVAL_MS) return 'objective_profile_interval_too_long';
  return null;
}

function resolveProfileValueRejectionReason(
  intervalMs: number,
  valueDelta: number,
): string | null {
  const minRise = MIN_VALUE_RISE;
  if (valueDelta < minRise) return valueDelta >= 0
    ? 'objective_profile_rise_too_small'
    : 'objective_profile_value_fell';
  const unitPerHour = calculateUnitPerHour({ intervalMs, valueDelta });
  if (!Number.isFinite(unitPerHour) || unitPerHour <= 0 || unitPerHour > MAX_UNIT_PER_HOUR) {
    return 'objective_profile_rate_out_of_range';
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

// Records the (input, kWh/unit) sample in the per-device ring buffer and
// re-fits the band layout. Returning a partial Pick lets the caller spread
// the update inline without branching twice on whether kWh/unit is known.
function resolveBandedUpdate(params: {
  previous: DeviceObjectiveProfile;
  previousSample: DeviceObjectiveProfileSample;
  sample: DeviceObjectiveProfileSample;
  kwhPerUnit: number | undefined;
  outdoorTemperatureC?: number;
}): Partial<Pick<DeviceObjectiveProfile, 'samples' | 'bands'>> {
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
  // undefined key is dropped on JSON serialization for `power_tracker_state`.
  return { samples, bands };
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
