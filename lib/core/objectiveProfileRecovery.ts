import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './objectiveProfileTypes';

// Magnitude thresholds that classify a sample-to-sample drop as a draw/refill
// event rather than ordinary measurement noise.
export const SHARP_FALL_TEMPERATURE_C = 1.0;
export const SHARP_FALL_SOC_PERCENT = 5.0;
export const RECOVERY_SAFETY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type RecoveryAction =
  | 'arm_recovery'
  | 'disarm_recovery'
  | 'reset_baseline'
  | 'reject_recovering'
  | 'noop';

export type RecoveryResolution = {
  action: RecoveryAction;
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

  if (!recovered && !timedOut) {
    return {
      action: 'reject_recovering',
      nextProfile: {
        ...previous,
        updatedAtMs: sample.observedAtMs,
        lastSample: sample,
        rejectedSamples: previous.rejectedSamples + 1,
      },
    };
  }

  // Disarm: clear recovery fields. The current sample becomes the new baseline;
  // the next sample is the first eligible to update stats. The disarming
  // sample itself is excluded from learning, so it is counted as rejected
  // alongside other reseed-but-skip paths.
  const { recoveryTargetValue: _unusedTarget, recoveryArmedAtMs: _unusedArmedAt, ...rest } = previous;
  void _unusedTarget;
  void _unusedArmedAt;
  return {
    action: 'disarm_recovery',
    nextProfile: {
      ...rest,
      updatedAtMs: sample.observedAtMs,
      lastSample: sample,
      rejectedSamples: previous.rejectedSamples + 1,
    },
  };
}
