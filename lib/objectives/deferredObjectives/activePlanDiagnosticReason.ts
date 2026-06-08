import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

// Narrow diagnostic reason codes that the UI needs to render specific copy
// (e.g. "car unplugged" / "charger can't resume") beyond what `pendingReason`
// alone can express. Surfaced on the active plan even when it carries a cached
// `latest` revision, so the list chip stays honest after a mid-plan transition.
export const resolveDiagnosticReasonCode = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanDiagnosticReason | undefined => {
  if (diag.reasonCode === 'objective_invalid_session') return 'objective_invalid_session';
  if (diag.reasonCode === 'objective_charger_not_resumable') return 'objective_charger_not_resumable';
  return undefined;
};

// Return a copy of `plan` with `diagnosticReasonCode` set to `code` (or the key
// dropped when `code` is undefined). Shared by the pending-record refresh and the
// committed-plan refresh so both clear a recovered charger's stale code the same
// way — keeping the persisted JSON shape free of an explicit `undefined` key.
export const withDiagnosticReasonCode = (
  plan: DeferredObjectiveActivePlanV1,
  code: DeferredObjectiveActivePlanDiagnosticReason | undefined,
): DeferredObjectiveActivePlanV1 => {
  const { diagnosticReasonCode: _drop, ...rest } = plan;
  return code === undefined ? rest : { ...rest, diagnosticReasonCode: code };
};
