import {
  SOFT_OVERSHOOT_DEADBAND_KW,
  SOFT_OVERSHOOT_PERSIST_MS,
} from './planConstants';
import type { PlanEngineState } from './planState';

export type SoftOvershootDecision = {
  actionable: boolean;
  pendingSinceMs: number | null;
};

export function resolveSoftOvershootDecision(params: {
  headroomKw: number | null;
  state: PlanEngineState;
  nowTs: number;
}): SoftOvershootDecision {
  const { headroomKw, state, nowTs } = params;
  if (headroomKw === null || headroomKw >= 0) {
    return { actionable: false, pendingSinceMs: null };
  }

  const deficitKw = -headroomKw;
  if (deficitKw >= SOFT_OVERSHOOT_DEADBAND_KW) {
    return { actionable: true, pendingSinceMs: null };
  }

  const pendingSinceMs = state.softOvershootPendingSinceMs ?? nowTs;
  if (nowTs - pendingSinceMs >= SOFT_OVERSHOOT_PERSIST_MS) {
    return { actionable: true, pendingSinceMs };
  }

  return { actionable: false, pendingSinceMs };
}
