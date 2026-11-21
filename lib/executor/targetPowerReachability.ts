import type {
  TargetPowerReachabilityState,
} from '../../packages/contracts/src/types';

const PROBE_RETRY_DELAYS_MS = [15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000] as const;

export type TargetPowerProbeCommand = {
  requestedPowerW: number;
  confirmedMaxPowerW: number;
  issuedAtMs: number;
  settleWindowMs: number;
};

export type TargetPowerReachabilityTransition =
  | { kind: 'waiting' }
  | { kind: 'confirmed'; reachability: TargetPowerReachabilityState }
  | { kind: 'reported_below_request'; reachability: TargetPowerReachabilityState; observation: ExactObservation }
  | { kind: 'no_post_command_report'; reachability: TargetPowerReachabilityState };

export const resolveTargetPowerProbeRetryAtMs = (
  nowMs: number,
  failureCount: number,
): number => {
  const index = Math.min(Math.max(1, Math.trunc(failureCount)) - 1, PROBE_RETRY_DELAYS_MS.length - 1);
  // The ladder is a fixed const tuple and the index is clamped into it at both ends, so
  // the first rung is an unreachable rather than a substituted value.
  return nowMs + (PROBE_RETRY_DELAYS_MS[index] ?? PROBE_RETRY_DELAYS_MS[0]);
};

type ExactObservation = { planningPowerW: number; observedAtMs: number };

const resolveObservationAtOrAfter = (
  observation: ExactObservation | undefined,
  thresholdMs: number,
): ExactObservation | undefined => (
  observation && observation.observedAtMs >= thresholdMs ? observation : undefined
);

const resolveProvenMaximum = (
  currentReachability: TargetPowerReachabilityState | undefined,
  command: TargetPowerProbeCommand,
): number => currentReachability?.maxReachedPowerW ?? command.confirmedMaxPowerW;

const buildConfirmedTransition = (
  profileFingerprint: string,
  currentReachability: TargetPowerReachabilityState | undefined,
  command: TargetPowerProbeCommand,
  observation: ExactObservation,
): TargetPowerReachabilityTransition => ({
  kind: 'confirmed',
  reachability: {
    profileFingerprint,
    maxReachedPowerW: Math.max(resolveProvenMaximum(currentReachability, command), observation.planningPowerW),
    probeFailureCount: 0,
  },
});

const buildFailedTransition = (
  profileFingerprint: string,
  currentReachability: TargetPowerReachabilityState | undefined,
  command: TargetPowerProbeCommand,
  postCommandObservation: ExactObservation | undefined,
  nowMs: number,
): TargetPowerReachabilityTransition => {
  const failureCount = (currentReachability?.probeFailureCount ?? 0) + 1;
  const provenMaximum = resolveProvenMaximum(currentReachability, command);
  const reachability: TargetPowerReachabilityState = {
    profileFingerprint,
    maxReachedPowerW: postCommandObservation
      ? Math.max(provenMaximum, postCommandObservation.planningPowerW) : provenMaximum,
    probeFailureCount: failureCount,
    nextProbeAtMs: resolveTargetPowerProbeRetryAtMs(nowMs, failureCount),
  };
  return postCommandObservation
    ? { kind: 'reported_below_request', reachability, observation: postCommandObservation }
    : { kind: 'no_post_command_report', reachability };
};

/**
 * Executor-owned convergence for one explicitly admitted reachability probe.
 * Ordinary in-ladder step changes never enter this state machine.
 */
export const resolveTargetPowerReachabilityTransition = (
  profileFingerprint: string,
  currentReachability: TargetPowerReachabilityState | undefined,
  command: TargetPowerProbeCommand,
  observation: ExactObservation | undefined,
  nowMs: number,
): TargetPowerReachabilityTransition => {
  const postCommandObservation = resolveObservationAtOrAfter(observation, command.issuedAtMs);
  if (postCommandObservation && postCommandObservation.planningPowerW >= command.requestedPowerW - 1) {
    return buildConfirmedTransition(profileFingerprint, currentReachability, command, postCommandObservation);
  }

  const settleAtMs = command.issuedAtMs + command.settleWindowMs;
  if (nowMs < settleAtMs) return { kind: 'waiting' };

  // Homey may only date changes. At settlement the latest post-command report
  // still describes the reported target even if its value did not change again.
  return buildFailedTransition(
    profileFingerprint, currentReachability, command, postCommandObservation, nowMs,
  );
};
