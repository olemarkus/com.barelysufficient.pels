// Lifecycle fields spread onto the `active_plan_revision_pending` /
// `active_plan_revision_written` structured-debug events emitted by
// `DeferredObjectiveActivePlanRecorder`. Lets one event answer "when did this
// task start, what deadline did the user set, what target" without correlating
// to a downstream `deferred_objective_horizon_planned` cycle. All values are
// already on `DeferredObjectiveActivePlanV1` / the diagnostic; this is purely
// additive logging. Lives beside `activePlanRecorder.ts` so that file stays
// under the `max-lines` lint cap.
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectiveSettingsKind } from '../../../packages/contracts/src/deferredObjectiveSettings';

export const buildActivePlanLifecycleFields = (
  diag: DeferredObjectiveDiagnostic,
  startedAtMs: number,
): {
  startedAtMs: number;
  deadlineAtMs: number | null;
  objectiveKind: DeferredObjectiveSettingsKind;
  targetTemperatureC: number | null;
  targetPercent: number | null;
  // The target in the task's own unit, for every kind (an energy task's kWh
  // has no column of its own above).
  targetValue: number;
} => ({
  startedAtMs,
  deadlineAtMs: diag.deadlineAtMs,
  objectiveKind: diag.objectiveKind,
  targetTemperatureC: diag.objectiveKind === 'temperature' ? diag.targetTemperatureC : null,
  targetPercent: diag.targetPercent,
  targetValue: diag.targetValue,
});
