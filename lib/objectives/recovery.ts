import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './types';

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
// Hysteresis band: counter-reset requires a forward delta strictly larger than
// this multiple of the progress epsilon. Sub-band jitter (the common case for
// sensors at rest) is treated as no-progress so a slow, mostly-flat refill
// can't perpetually re-arm the counter via positive noise crossings.
export const RECOVERY_PROGRESS_RESET_MULTIPLIER = 5;
// Wall-clock floor for the no-progress disarm path, measured from
// `recoveryArmedAtMs`. With 10s polling, four consecutive no-progress samples
// can accumulate in 40s; a heater whose first post-arm sample is still cooling
// would then be disarmed long before any rebuild had a chance to start. 30 min
// is long enough that a legitimate slow refill has had time to start producing
// >5*EPSILON deltas, and short enough that a real cap-shed cooling pattern
// isn't kept armed for hours when the planner could be reusing the slot.
// Intentionally a poll-mode (`power_source = homey_energy`) safeguard only:
// under `power_source = flow` sample intervals are typically 1-6 h, so the
// four-sample counter is already the binding constraint and the floor is a
// no-op. The 24 h `RECOVERY_SAFETY_TIMEOUT_MS` bounds the worst-case in
// either mode.
export const RECOVERY_NO_PROGRESS_MIN_DURATION_MS = 30 * 60 * 1000;

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
  // no-progress counter when the sample-to-sample delta fails to clear the
  // hysteresis band (`5 * EPSILON`); once it hits the limit AND the armed
  // window has been open at least `RECOVERY_NO_PROGRESS_MIN_DURATION_MS`,
  // disarm with `no_progress`. Anything inside the hysteresis band is treated
  // as no-progress so sub-epsilon sensor noise crossing zero can't perpetually
  // reset the counter; the wall-clock floor prevents premature disarm under
  // fast 10s polling where four near-flat samples can land in <1 min.
  const previousNoProgress = previous.recoveryNoProgressSamples ?? 0;
  const forwardDelta = sample.value - previous.lastSample.value;
  const resetThreshold = RECOVERY_PROGRESS_RESET_MULTIPLIER * RECOVERY_PROGRESS_EPSILON;
  const nextNoProgress = forwardDelta > resetThreshold ? 0 : previousNoProgress + 1;

  if (
    nextNoProgress >= RECOVERY_NO_PROGRESS_SAMPLE_LIMIT
    && ageMs >= RECOVERY_NO_PROGRESS_MIN_DURATION_MS
  ) {
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
