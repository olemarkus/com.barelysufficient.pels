import {
  SHED_GRACE_MAX_MS,
  SOFT_OVERSHOOT_DEADBAND_KW,
  SOFT_OVERSHOOT_PERSIST_MS,
} from './planConstants';

export type SoftOvershootDecision = {
  /** Record real pressure immediately, including while deliberately waiting. */
  actionable: boolean;
  /** Whether this build may select new restrictions. */
  shedActionable: boolean;
  pendingSinceMs: number | null;
};

/** Episode persistence; the period allowance decides whether waiting is funded. */
export function resolveSoftOvershootDecision(
  headroomKw: number,
  graceAllowed: boolean,
  previousPendingSinceMs: number | null,
  nowTs: number,
): SoftOvershootDecision {
  if (headroomKw >= 0) {
    return { actionable: false, shedActionable: false, pendingSinceMs: null };
  }
  const pendingSinceMs = previousPendingSinceMs ?? nowTs;
  const elapsedMs = nowTs - pendingSinceMs;
  if (-headroomKw < SOFT_OVERSHOOT_DEADBAND_KW) {
    const actionable = elapsedMs >= SOFT_OVERSHOOT_PERSIST_MS;
    return { actionable, shedActionable: actionable, pendingSinceMs };
  }
  return {
    actionable: true,
    shedActionable: !graceAllowed || elapsedMs >= SHED_GRACE_MAX_MS,
    pendingSinceMs,
  };
}
