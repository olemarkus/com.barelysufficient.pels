import type { TargetDeviceSnapshot } from '../utils/types';
import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './objectiveProfileTypes';
import type { PowerTrackerState } from './powerTrackerTypes';
import { shouldEmitRejectedProfileSample } from './objectiveProfileRejectionLogging';
import { resolveRecoveryState, type RecoveryAction, type RecoveryDisarmReason } from './objectiveProfileRecovery';
import { updateProfileStat } from './objectiveProfileStats';
import { appendSampleToBuffer, fitBandsFromSamples } from './objectiveProfileBands';
import { buildObjectiveProfileSample } from './objectiveProfileSamples';

export type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './objectiveProfileTypes';

export {
  OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS,
  OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS,
  buildObjectiveProfileSample,
} from './objectiveProfileSamples';

export const OBJECTIVE_PROFILE_MAX_DEVICES = 64;
export const OBJECTIVE_PROFILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const OBJECTIVE_PROFILE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const OBJECTIVE_PROFILE_MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_TEMPERATURE_RISE_C = 0.2;
const MIN_SOC_RISE_PERCENT = 0.2;
const MAX_KWH_PER_DEGREE_C = 10;
const MAX_KWH_PER_PERCENT = 5;
const MAX_UNIT_PER_HOUR = 100;

export type ObjectiveProfileDebugEmitter = (payload: Record<string, unknown>) => void;

export function updateObjectiveProfilesFromSnapshot(params: {
  state: PowerTrackerState;
  devices: TargetDeviceSnapshot[];
  nowMs: number;
  debugStructured?: ObjectiveProfileDebugEmitter;
}): PowerTrackerState {
  const { state, devices, nowMs, debugStructured } = params;
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
}): DeviceObjectiveProfile {
  const {
    previous,
    sample,
    deviceId,
    deviceName,
    debugStructured,
  } = params;
  if (!previous || previous.kind !== resolveKindForSample(sample)) {
    return buildInitialProfile(sample);
  }

  const previousSample = previous.lastSample;
  const intervalMs = getProfileIntervalMs(previousSample, sample);
  const valueDelta = getProfileValueDelta(previousSample, sample);

  // Timing checks (non-monotonic time, too-short/too-long intervals, unit
  // changes) must run before recovery so a stale or out-of-order sample
  // cannot arm a 24h recovery window or reset the EV baseline.
  const intervalRejection = resolveProfileIntervalRejectionReason({
    previousSample,
    sample,
    intervalMs,
  });
  if (intervalRejection) {
    emitRejectedProfileSample({
      previous,
      deviceId,
      deviceName,
      debugStructured,
      intervalMs,
      valueDelta,
      rejectionReason: intervalRejection,
    });
    return buildRejectedProfileSample({
      previous,
      sample,
      rejectionReason: intervalRejection,
    });
  }

  const recovery = resolveRecoveryState({ previous, sample });
  if (recovery.action !== 'noop' && recovery.nextProfile) {
    emitRecoveryStateEvent({
      action: recovery.action,
      disarmReason: recovery.disarmReason,
      previous,
      nextProfile: recovery.nextProfile,
      sample,
      deviceId,
      deviceName,
      debugStructured,
    });
    return recovery.nextProfile;
  }

  const rejectionReason = resolveProfileValueOrEnergyRejectionReason({
    previousSample,
    sample,
    intervalMs,
    valueDelta,
  });
  if (rejectionReason) {
    emitRejectedProfileSample({
      previous,
      deviceId,
      deviceName,
      debugStructured,
      intervalMs,
      valueDelta,
      rejectionReason,
    });
    return buildRejectedProfileSample({
      previous,
      sample,
      rejectionReason,
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
  });
}

function buildAcceptedProfileSample(params: {
  previous: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
  deviceId?: string;
  deviceName?: string;
  debugStructured?: ObjectiveProfileDebugEmitter;
  intervalMs: number;
  valueDelta: number;
}): DeviceObjectiveProfile {
  const {
    previous,
    sample,
    deviceId,
    deviceName,
    debugStructured,
    intervalMs,
    valueDelta,
  } = params;
  const previousSample = previous.lastSample;
  const unitPerHour = calculateUnitPerHour({ intervalMs, valueDelta });
  const energyKwh = calculateEnergyKwh(previousSample, intervalMs);
  const kwhPerUnit = energyKwh !== undefined ? calculateKwhPerUnit({ energyKwh, valueDelta }) : undefined;
  const bandedUpdate = resolveBandedUpdate({ previous, previousSample, sample, kwhPerUnit });
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
  };
  debugStructured?.({
    event: 'objective_profile_sample_recorded',
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    profileKind: nextProfile.kind,
    intervalMs,
    valueDelta,
    unitPerHour,
    kwhPerUnit: kwhPerUnit ?? null,
    energyKwh: energyKwh ?? null,
    acceptedSamples: nextProfile.acceptedSamples,
    rateConfidence: nextProfile.unitPerHour.confidence,
    energyConfidence: nextProfile.kwhPerUnit?.confidence ?? null,
    powerSource: previousSample.powerSource ?? null,
    bufferedSamples: nextProfile.samples?.length ?? 0,
    bandsCount: nextProfile.bands?.length ?? 0,
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
    };
  }
  return {
    ...previous,
    rejectedSamples: previous.rejectedSamples + 1,
  };
}

function emitRecoveryStateEvent(params: {
  action: RecoveryAction;
  disarmReason?: RecoveryDisarmReason;
  previous: DeviceObjectiveProfile;
  nextProfile: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
  deviceId?: string;
  deviceName?: string;
  debugStructured?: ObjectiveProfileDebugEmitter;
}): void {
  const {
    action,
    disarmReason,
    previous,
    nextProfile,
    sample,
    deviceId,
    deviceName,
    debugStructured,
  } = params;
  if (!debugStructured) return;
  // Prefer the post-state for the recovery target so `arm_recovery` reports
  // the value being protected, not the (undefined) prior value.
  const recoveryTargetValue = nextProfile.recoveryTargetValue
    ?? previous.recoveryTargetValue
    ?? null;
  debugStructured({
    event: 'objective_profile_recovery_state',
    action,
    ...(disarmReason ? { disarmReason } : {}),
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    profileKind: previous.kind,
    sampleValue: sample.value,
    previousValue: previous.lastSample.value,
    recoveryTargetValue,
  });
}

function emitRejectedProfileSample(params: {
  previous: DeviceObjectiveProfile;
  deviceId?: string;
  deviceName?: string;
  debugStructured?: ObjectiveProfileDebugEmitter;
  intervalMs: number;
  valueDelta: number;
  rejectionReason: string;
}): void {
  const {
    previous,
    deviceId,
    deviceName,
    debugStructured,
    intervalMs,
    valueDelta,
    rejectionReason,
  } = params;
  if (!shouldEmitRejectedProfileSample({ deviceId, rejectionReason })) return;
  debugStructured?.({
    event: 'objective_profile_sample_rejected',
    reasonCode: rejectionReason,
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    profileKind: previous.kind,
    intervalMs,
    valueDelta,
  });
}

function resolveProfileValueOrEnergyRejectionReason(params: {
  previousSample: DeviceObjectiveProfileSample;
  sample: DeviceObjectiveProfileSample;
  intervalMs: number;
  valueDelta: number;
}): string | null {
  const { previousSample, sample, intervalMs, valueDelta } = params;
  const valueReason = resolveProfileValueRejectionReason({ sample, intervalMs, valueDelta });
  if (valueReason) return valueReason;
  return resolveProfileEnergyRejectionReason({ previousSample, sample, intervalMs, valueDelta });
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
  return sample.unit !== previousSample.unit ? 'objective_profile_unit_changed' : null;
}

function resolveProfileValueRejectionReason(params: {
  sample: DeviceObjectiveProfileSample;
  intervalMs: number;
  valueDelta: number;
}): string | null {
  const { sample, intervalMs, valueDelta } = params;
  const minRise = sample.unit === 'degree_c' ? MIN_TEMPERATURE_RISE_C : MIN_SOC_RISE_PERCENT;
  if (valueDelta < minRise) return valueDelta >= 0
    ? 'objective_profile_rise_too_small'
    : 'objective_profile_value_fell';
  const unitPerHour = calculateUnitPerHour({ intervalMs, valueDelta });
  if (!Number.isFinite(unitPerHour) || unitPerHour <= 0 || unitPerHour > MAX_UNIT_PER_HOUR) {
    return 'objective_profile_rate_out_of_range';
  }
  return null;
}

function resolveProfileEnergyRejectionReason(params: {
  previousSample: DeviceObjectiveProfileSample;
  sample: DeviceObjectiveProfileSample;
  intervalMs: number;
  valueDelta: number;
}): string | null {
  const {
    previousSample,
    sample,
    intervalMs,
    valueDelta,
  } = params;
  if (typeof previousSample.crediblePowerW !== 'number') return null;
  const energyKwh = calculateEnergyKwh(previousSample, intervalMs);
  const kwhPerUnit = energyKwh !== undefined ? calculateKwhPerUnit({ energyKwh, valueDelta }) : undefined;
  const maxKwhPerUnit = sample.unit === 'degree_c' ? MAX_KWH_PER_DEGREE_C : MAX_KWH_PER_PERCENT;
  if (kwhPerUnit === undefined || !Number.isFinite(kwhPerUnit) || kwhPerUnit <= 0 || kwhPerUnit > maxKwhPerUnit) {
    return 'objective_profile_energy_per_unit_out_of_range';
  }
  return null;
}

function getProfileIntervalMs(
  previousSample: DeviceObjectiveProfileSample,
  sample: DeviceObjectiveProfileSample,
): number {
  return sample.observedAtMs - previousSample.observedAtMs;
}

function getProfileValueDelta(
  previousSample: DeviceObjectiveProfileSample,
  sample: DeviceObjectiveProfileSample,
): number {
  return sample.value - previousSample.value;
}

function calculateUnitPerHour(params: {
  intervalMs: number;
  valueDelta: number;
}): number {
  return params.valueDelta / (params.intervalMs / 3_600_000);
}

function calculateEnergyKwh(
  previousSample: DeviceObjectiveProfileSample,
  intervalMs: number,
): number | undefined {
  return typeof previousSample.crediblePowerW === 'number'
    ? previousSample.crediblePowerW * (intervalMs / 3_600_000) / 1000
    : undefined;
}

function calculateKwhPerUnit(params: {
  energyKwh: number;
  valueDelta: number;
}): number {
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
}): Partial<Pick<DeviceObjectiveProfile, 'samples' | 'bands'>> {
  const { previous, previousSample, sample, kwhPerUnit } = params;
  if (kwhPerUnit === undefined) return {};
  // Tag the sample by the midpoint of the rise so the band layout reflects
  // where the energy was actually deposited, not just the end value.
  const inputValue = (previousSample.value + sample.value) / 2;
  const samples = appendSampleToBuffer(previous.samples, {
    observedAtMs: sample.observedAtMs,
    inputValue,
    kwhPerUnit,
  });
  const bands = fitBandsFromSamples({ samples, kind: previous.kind });
  // Explicit `bands: undefined` clears any prior layout if the fitter declines
  // to publish one (e.g., the buffer dipped under the split threshold). The
  // undefined key is dropped on JSON serialization for `power_tracker_state`.
  return { samples, bands };
}

function buildInitialProfile(sample: DeviceObjectiveProfileSample): DeviceObjectiveProfile {
  return {
    kind: resolveKindForSample(sample),
    updatedAtMs: sample.observedAtMs,
    lastSample: sample,
    acceptedSamples: 0,
    rejectedSamples: 0,
  };
}

function resolveKindForSample(sample: DeviceObjectiveProfileSample): DeviceObjectiveProfile['kind'] {
  return sample.unit === 'degree_c' ? 'temperature' : 'ev_soc';
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
