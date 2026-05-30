// Plan-level duration helpers used by `activePlanRecorder`. Split out so the
// recorder file stays under the codebase's max-lines ceiling and to keep the
// duration-formatting + plan-level snapshot logic co-located with the
// resolution rules that govern it.
//
// Plan-level snapshot rules: the recorder formats `estimatedDurationText`
// from `energyNeededKWh / planningSpeedKw` on every revision, and
// `energyNeededKWh` shrinks every cycle as the device consumes energy
// (`diagnosticsBridge.ts` recomputes it from `progress.remainingUnits`). The
// snapshot is frozen at first-revision time so the hero meta line reflects
// the user's original commitment, not the shrinking remaining estimate.
// `objective_changed` resets the snapshot — target/deadline shift is a fresh
// plan from the user's perspective. Other replan reasons preserve the
// snapshot, with backfill from the new revision when a legacy persisted plan
// (recorded before this snapshot shipped) hits its first replan.
import type {
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

// Formats kWh / kW into "Yh Zm" or "Zm" when sub-hour. Returns null when the
// computation isn't useful (missing inputs or zero energy needed). The
// recorder writes the formatted string onto the persisted revision so the
// hero meta line and any future flow-token consumer agree on the rounding
// and unit conventions.
export const formatEstimatedDuration = (
  energyNeededKWh: number,
  planningSpeedKw: number | null,
): string | null => {
  if (!Number.isFinite(energyNeededKWh) || energyNeededKWh <= 0) return null;
  if (typeof planningSpeedKw !== 'number' || !Number.isFinite(planningSpeedKw) || planningSpeedKw <= 0) {
    return null;
  }
  const totalMinutes = Math.max(1, Math.round((energyNeededKWh / planningSpeedKw) * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  if (hours <= 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

export type PlanLevelDurationSnapshot = {
  initialPlanningSpeedKw: number | undefined;
  initialEstimatedDurationText: string | undefined;
};

export const resolvePlanLevelDurationSnapshot = (params: {
  current: DeferredObjectiveActivePlanV1;
  revision: DeferredObjectiveActivePlanRevisionV1;
  reason: DeferredObjectiveActivePlanRevisionReason;
}): PlanLevelDurationSnapshot => {
  const reset = params.reason === 'objective_changed';
  return {
    initialPlanningSpeedKw: reset
      ? params.revision.planningSpeedKw
      : (params.current.initialPlanningSpeedKw ?? params.revision.planningSpeedKw),
    initialEstimatedDurationText: reset
      ? params.revision.estimatedDurationText
      : (params.current.initialEstimatedDurationText ?? params.revision.estimatedDurationText),
  };
};

// Persisted shape for the plan-level duration snapshot: spreadable subset that
// only carries keys whose values are defined. Callers spread the result into
// the active plan object so the `objective_changed` reset path can drop the
// keys entirely (instead of leaving explicit `undefined` values that violate
// `exactOptionalPropertyTypes`-style contracts) while non-reset replans still
// preserve/backfill the prior snapshot values via `resolvePlanLevelDurationSnapshot`.
export type PersistedPlanLevelDurationFields = Partial<{
  initialPlanningSpeedKw: number;
  initialEstimatedDurationText: string;
}>;

export const toPersistedPlanLevelDurationFields = (
  snapshot: PlanLevelDurationSnapshot,
): PersistedPlanLevelDurationFields => ({
  ...(snapshot.initialPlanningSpeedKw !== undefined
    ? { initialPlanningSpeedKw: snapshot.initialPlanningSpeedKw }
    : {}),
  ...(snapshot.initialEstimatedDurationText !== undefined
    ? { initialEstimatedDurationText: snapshot.initialEstimatedDurationText }
    : {}),
});
