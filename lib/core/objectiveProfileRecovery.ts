import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './objectiveProfileTypes';

// Magnitude thresholds that classify a sample-to-sample drop as a draw/refill
// event rather than ordinary measurement noise.
export const SHARP_FALL_TEMPERATURE_C = 1.0;
export const SHARP_FALL_SOC_PERCENT = 5.0;
export const RECOVERY_SAFETY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// After this many consecutive armed-window samples with no positive movement
// toward `recoveryTargetValue`, disarm the recovery window. Protects against
// cap-shed thermostats that never warm back to the pre-drop value and would
// otherwise stay rejected for the full 24h safety timeout.
export const RECOVERY_NO_PROGRESS_SAMPLE_LIMIT = 4;
// Minimum forward-delta (in the device's own unit) that counts as progress.
// Smaller-than-this jitter increments the no-progress counter.
export const RECOVERY_PROGRESS_EPSILON = 0.01;

export type RecoveryDisarmReason = 'recovered' | 'safety_timeout' | 'no_progress';

export type RecoveryAction =
  | 'arm_recovery'
  | 'disarm_recovery'
  | 'reset_baseline'
  | 'reject_recovering'
  | 'noop';

export type RecoveryResolution = {
  action: RecoveryAction;
  // Populated only on `disarm_recovery` so telemetry can distinguish a clean
  // target-reached recovery from the safety-timeout or no-progress paths.
  disarmReason?: RecoveryDisarmReason;
  nextProfile?: DeviceObjectiveProfile;
};

export function resolveRecoveryState(params: {
  previous: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
}): RecoveryResolution {
  const { previous, sample } = params;
  const previousValue = previous.lastSample.value;
  const valueDelta = sample.value - previousValue;
  const isThermostat = previous.kind === 'temperature';

  if (previous.recoveryTargetValue !== undefined && previous.recoveryArmedAtMs !== undefined) {
    return resolveArmedRecovery({ previous, sample });
  }

  const sharpFallThreshold = isThermostat ? SHARP_FALL_TEMPERATURE_C : SHARP_FALL_SOC_PERCENT;
  if (-valueDelta < sharpFallThreshold) {
    return { action: 'noop' };
  }

  if (!isThermostat) {
    return {
      action: 'reset_baseline',
      nextProfile: {
        ...previous,
        updatedAtMs: sample.observedAtMs,
        lastSample: sample,
        rejectedSamples: previous.rejectedSamples + 1,
      },
    };
  }

  return {
    action: 'arm_recovery',
    nextProfile: {
      ...previous,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
      recoveryTargetValue: previousValue,
      recoveryArmedAtMs: sample.observedAtMs,
    },
  };
}

function resolveArmedRecovery(params: {
  previous: DeviceObjectiveProfile;
  sample: DeviceObjectiveProfileSample;
}): RecoveryResolution {
  const { previous, sample } = params;
  const recoveryTargetValue = previous.recoveryTargetValue ?? Number.POSITIVE_INFINITY;
  const recoveryArmedAtMs = previous.recoveryArmedAtMs ?? sample.observedAtMs;
  const ageMs = sample.observedAtMs - recoveryArmedAtMs;
  const recovered = sample.value >= recoveryTargetValue;
  const timedOut = ageMs >= RECOVERY_SAFETY_TIMEOUT_MS;

  if (recovered) return disarm(previous, sample, 'recovered');
  if (timedOut) return disarm(previous, sample, 'safety_timeout');

  // Forward-progress check: a cap-shed thermostat cools *away* from the pre-drop
  // value and would otherwise stay armed for the full 24h timeout. Increment a
  // no-progress counter on any non-positive delta vs the previous sample; once
  // it hits the limit, disarm with `no_progress`. Any positive delta resets it
  // — a slow but trending-up rebuild stays armed normally.
  const previousNoProgress = previous.recoveryNoProgressSamples ?? 0;
  const forwardDelta = sample.value - previous.lastSample.value;
  const nextNoProgress = forwardDelta > RECOVERY_PROGRESS_EPSILON ? 0 : previousNoProgress + 1;

  if (nextNoProgress >= RECOVERY_NO_PROGRESS_SAMPLE_LIMIT) {
    return disarm(previous, sample, 'no_progress');
  }

  return {
    action: 'reject_recovering',
    nextProfile: {
      ...previous,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
      recoveryNoProgressSamples: nextNoProgress,
    },
  };
}

// Clear recovery fields. The disarming sample becomes the new baseline; the
// next sample is the first eligible to update stats. The disarming sample
// itself is excluded from learning, so it is counted as rejected alongside
// other reseed-but-skip paths. `samples` and `bands` are preserved per
// `notes/objective-profile-bands.md`.
function disarm(
  previous: DeviceObjectiveProfile,
  sample: DeviceObjectiveProfileSample,
  disarmReason: RecoveryDisarmReason,
): RecoveryResolution {
  const {
    recoveryTargetValue: _unusedTarget,
    recoveryArmedAtMs: _unusedArmedAt,
    recoveryNoProgressSamples: _unusedNoProgress,
    ...rest
  } = previous;
  void _unusedTarget;
  void _unusedArmedAt;
  void _unusedNoProgress;
  return {
    action: 'disarm_recovery',
    disarmReason,
    nextProfile: {
      ...rest,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
    },
  };
}
