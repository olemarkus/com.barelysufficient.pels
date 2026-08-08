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
  current?: DeferredObjectiveActivePlanDiagnosticReason,
): DeferredObjectiveActivePlanDiagnosticReason | undefined => {
  // The device is not in this cycle's plan input, so this diagnostic carries no
  // information about the overlay. HOLD whatever is already persisted: resolving
  // to `undefined` would clear a standing `objective_invalid_session` /
  // `objective_charger_not_resumable` / `objective_device_left_off` with no
  // grace, and the user's chip would flip back to a cached "On track" on a
  // momentary gap. A real recovery arrives as a diagnostic that names itself.
  if (diag.reasonCode === 'objective_missing_device') return current;
  if (diag.reasonCode === 'objective_invalid_session') return 'objective_invalid_session';
  if (diag.reasonCode === 'objective_charger_not_resumable') return 'objective_charger_not_resumable';
  if (diag.reasonCode === 'objective_device_in_sub_home') return 'objective_device_in_sub_home';
  // "Leave off until turned on again". The status downgrade in `diagnosticsBridge`
  // only reaches the LIVE diagnostic; `planStatus` / `floorShortfallCause` are not
  // rewritten until the next `:58` settle. Routing the cause through here puts it
  // on the persisted plan every cycle — which is what the settings UI and the
  // widget read — so the chip stops claiming "On track" the moment the device
  // goes off, and stops claiming risk the moment it is turned back on.
  if (diag.externalOffHoldActive === true) return 'objective_device_left_off';
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
