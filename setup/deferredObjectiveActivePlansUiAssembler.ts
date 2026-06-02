import type { DeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanHistoryRecorder } from '../lib/objectives/deferredObjectives/planHistory';

// Stitches the live in-progress trajectory (start progress + hourly observed
// samples) onto the active-plans UI snapshot so the smart-tasks widget can draw
// a planned-vs-actual progress chart for a still-running task. The observed
// readings live on the plan-history recorder's in-flight records, not on the
// active-plan store, so this is the one place the two are merged — and only on
// the UI payload, never on the persisted snapshot (see the field doc on
// `DeferredObjectiveActivePlanV1.progressSamples`).
//
// Returns a fresh object graph (per-plan spread) so a caller can never mutate
// the recorder's persisted snapshot through the returned payload. When no
// history recorder is wired (degraded boot) the snapshot passes through
// untouched — the widget falls back to a chartless detail panel.
export const assembleActivePlansWithTrajectory = (
  snapshot: DeferredObjectiveActivePlansV1,
  historyRecorder: DeferredObjectivePlanHistoryRecorder | undefined,
): DeferredObjectiveActivePlansV1 => {
  if (!historyRecorder) return snapshot;
  const plansByDeviceId = Object.fromEntries(
    Object.entries(snapshot.plansByDeviceId).map(([deviceId, plan]) => {
      // Defensive: pass a null/absent plan through untouched (spreading it would
      // synthesize a bogus partial object). The contract types plans as
      // non-null, but the consuming widget already guards for null, so mirror it.
      const trajectory = plan ? historyRecorder.getInProgressTrajectory(deviceId) : null;
      if (trajectory === null) return [deviceId, plan] as const;
      return [deviceId, {
        ...plan,
        startProgressC: trajectory.startProgressC,
        startProgressPercent: trajectory.startProgressPercent,
        progressSamples: trajectory.progressSamples,
      }] as const;
    }),
  );
  return { ...snapshot, plansByDeviceId };
};
