import type {
  DeferredObjectiveActivePlansV1,
  DeliveredEnergyReader,
  ResolvedDeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { toResolvedActivePlan } from '../../../packages/shared-domain/src/deferredActivePlanResolvedView';
import type { DeferredObjectivePlanHistoryRecorder } from './planHistory';

// The active plans as the UI receives them: each plan resolved to the
// `Resolved…` view (`toResolvedActivePlan`), with the live in-progress
// trajectory (start progress + 15-minute-grid observed samples) stitched on so
// the smart-tasks widget can draw a planned-vs-actual progress chart for a
// still-running task, and an energy task's energy delivered so far. The observed
// readings live on the plan-history recorder's in-flight records and the
// delivered energy on the delivery tracker, not on the active-plan store, so
// this is the one place the three are merged — and only on the UI payload,
// never on the persisted snapshot (see `DeferredObjectiveActivePlanTrajectory`).
//
// Returns a fresh object graph (per-plan spread) so a caller can never mutate
// the recorder's persisted snapshot through the returned payload. When no
// history recorder is wired (degraded boot) the snapshot is still resolved
// (just without a trajectory) — the widget falls back to a chartless detail
// panel.
export const assembleActivePlansUiView = (
  snapshot: DeferredObjectiveActivePlansV1,
  historyRecorder: DeferredObjectivePlanHistoryRecorder | undefined,
  readDeliveredEnergy: DeliveredEnergyReader,
): ResolvedDeferredObjectiveActivePlansV1 => {
  const plansByDeviceId = Object.fromEntries(
    Object.entries(snapshot.plansByDeviceId).map(([deviceId, plan]) => {
      // Defensive: pass a null/absent plan through untouched — resolving it (or
      // spreading it) would synthesize a bogus partial object. The contract
      // types plans as non-null, but the consuming widget already guards for
      // null, so mirror it.
      if (!plan) return [deviceId, plan] as const;
      const trajectory = historyRecorder?.getInProgressTrajectory(deviceId) ?? null;
      return [deviceId, toResolvedActivePlan(plan, readDeliveredEnergy, trajectory)] as const;
    }),
  );
  return { ...snapshot, plansByDeviceId };
};
