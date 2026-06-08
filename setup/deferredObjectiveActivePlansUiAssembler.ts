import type {
  DeferredObjectiveActivePlansV1,
  ResolvedDeferredObjectiveActivePlanV1,
  ResolvedDeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';
import {
  toResolvedActivePlan,
  toResolvedActivePlans,
} from '../packages/shared-domain/src/deferredActivePlanResolvedView';
import type { DeferredObjectivePlanHistoryRecorder } from '../lib/objectives/deferredObjectives/planHistory';

// Stitches the live in-progress trajectory (start progress + hourly observed
// samples) onto the active-plans UI snapshot so the smart-tasks widget can draw
// a planned-vs-actual progress chart for a still-running task. The observed
// readings live on the plan-history recorder's in-flight records, not on the
// active-plan store, so this is the one place the two are merged — and only on
// the UI payload, never on the persisted snapshot (see the field doc on
// `DeferredObjectiveActivePlanV1.progressSamples`).
//
// Also resolves each plan's kind-split (°C/%) value pairs to the unit-agnostic
// `Resolved…` view at this producer boundary, so UI consumers never see (or
// branch on) the raw columns. Returns a fresh object graph (per-plan spread) so
// a caller can never mutate the recorder's persisted snapshot through the
// returned payload. When no history recorder is wired (degraded boot) the
// snapshot is still resolved (just without a trajectory) — the widget falls back
// to a chartless detail panel.
export const assembleActivePlansWithTrajectory = (
  snapshot: DeferredObjectiveActivePlansV1,
  historyRecorder: DeferredObjectivePlanHistoryRecorder | undefined,
): ResolvedDeferredObjectiveActivePlansV1 => {
  if (!historyRecorder) return toResolvedActivePlans(snapshot);
  const plansByDeviceId = Object.fromEntries(
    Object.entries(snapshot.plansByDeviceId).map(([deviceId, plan]) => {
      // Defensive: pass a null/absent plan through untouched — resolving it (or
      // spreading it) would synthesize a bogus partial object. The contract
      // types plans as non-null, but the consuming widget already guards for
      // null, so mirror it.
      if (!plan) return [deviceId, plan as unknown as ResolvedDeferredObjectiveActivePlanV1] as const;
      const trajectory = historyRecorder.getInProgressTrajectory(deviceId);
      const stitched = trajectory === null ? plan : {
        ...plan,
        startProgressC: trajectory.startProgressC,
        startProgressPercent: trajectory.startProgressPercent,
        progressSamples: trajectory.progressSamples,
      };
      return [deviceId, toResolvedActivePlan(stitched)] as const;
    }),
  );
  return { ...snapshot, plansByDeviceId };
};
