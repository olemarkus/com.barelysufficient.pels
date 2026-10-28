import { readDeferredObjectiveLiveCompletion } from '../../../shared-domain/src/deferredObjectiveLiveCompletion';
import type {
  DeferredObjectiveActivePlanStatusV1,
  OverviewDeferredObjectiveActivePlan,
  OverviewDeferredObjectiveActivePlans,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import {
  normalizeDeferredObjectiveActivePlansShape,
} from '../../../shared-domain/src/deferredObjectiveActivePlanShape.ts';
import { bumpPlanSurface } from './planRedesign.ts';
import { state } from './state.ts';

// Narrow per-device predicate for the Overview view. The settings UI has no
// access to the runtime's deep `isActivePlan` validator (the `settings-ui ↛ lib`
// architecture boundary forbids importing it), so here a plan is "valid enough"
// when it is a non-null object with a finite `deadlineAtMs` (the smart-task
// row's ETA) whose `latest` is null (not yet planned) or a revision with a known
// `planStatus` (the smart-task row's verdict) and `hours` — what the Overview
// EV-state line and the first-start time walk — as an array of hours with a
// finite start and a finite `plannedKWh` (a booking may promise 0 kWh). Optional
// chaining does not guard a non-array `hours`, so the shape is checked here, at
// the persisted boundary, rather than by the resolver. This drops a non-object
// entry (e.g. a tampered `plansByDeviceId['ev-1'] = 7`) and a plan with a
// malformed deadline, a missing `latest`, a revision with no known verdict, or
// malformed hours.
const isOverviewHour = (hour: unknown): boolean => (
  typeof hour === 'object' && hour !== null
  && Number.isFinite((hour as { startsAtMs?: unknown }).startsAtMs)
  && Number.isFinite((hour as { plannedKWh?: unknown }).plannedKWh)
);

const PLAN_STATUSES: Record<DeferredObjectiveActivePlanStatusV1, true> = {
  at_risk: true,
  cannot_meet: true,
  invalid: true,
  on_track: true,
  satisfied: true,
};

const isPlanStatus = (value: unknown): boolean => (
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLAN_STATUSES, value)
);

const isOverviewLatest = (latest: unknown): boolean => {
  if (latest === null) return true;
  if (!isUnknownRecord(latest)) return false;
  const { hours, planStatus } = latest;
  return isPlanStatus(planStatus) && Array.isArray(hours) && hours.every(isOverviewHour);
};

const isOverviewPlanShaped = (plan: unknown): plan is OverviewDeferredObjectiveActivePlan => (
  isUnknownRecord(plan)
  && Number.isFinite(plan.deadlineAtMs)
  && isOverviewLatest(plan.latest)
);

// Browser-safe coercion of the active-plans view the bootstrap and the
// `deferred_objective_active_plans_updated` realtime push carry.
// The authoritative deep normaliser lives in `lib/objectives/**` (runtime
// backend) and the settings UI must not import across that architecture
// boundary, so it delegates the shared top-level shape/version guard
// (`normalizeDeferredObjectiveActivePlansShape` in shared-domain) and supplies
// the narrow Overview per-device predicate above. The shared guard enforces the
// version check and per-device filtering the UI previously skipped, and the
// Overview consumers (the `PlanDeviceCards` EV-state line and the smart-task row's
// `resolveSmartTaskListStatus`) read only the fields of the narrow
// `OverviewDeferredObjectiveActivePlans` view — value columns are deliberately
// unreachable here. Anything that is not a `{ version, plansByDeviceId: object }`
// blob (absent, malformed, version-mismatched, or a transient empty SDK read)
// coerces to `null` (the UI's empty fallback). The runtime recorder rejects the
// same shapes via the shared guard but degrades to an empty envelope rather than
// `null` — both refuse the blob; only the per-surface empty value differs.
export const coerceDeferredObjectiveActivePlans = (
  raw: unknown,
): OverviewDeferredObjectiveActivePlans | null => {
  const normalized = normalizeDeferredObjectiveActivePlansShape(raw, {
    isValidPlan: isOverviewPlanShaped,
    empty: () => null,
  });
  if (normalized === null) return null;
  return { ...normalized, plansByDeviceId: Object.fromEntries(
    Object.entries(normalized.plansByDeviceId).map(([deviceId, plan]) => [deviceId, {
      ...plan, liveCompletion: readDeferredObjectiveLiveCompletion(plan.liveCompletion),
    }]),
  ) };
};

// Apply the active plans the runtime pushed on a save
// (`deferred_objective_active_plans_updated`) to `state` and repaint the
// overview plan surface. The plans live in the userdata store, under no
// settings key, so the push carries the same resolved view the bootstrap's
// `deferredObjectiveActivePlans` gives, and it passes the same shape guard:
// without it the Overview device-card EV state line would show the
// pre-revision schedule until the WebView reloads. A payload that is not an
// active-plans view clears the state, as a malformed bootstrap value does.
export const applyDeferredObjectiveActivePlansPush = (payload: unknown): void => {
  state.deferredObjectiveActivePlans = coerceDeferredObjectiveActivePlans(payload);
  bumpPlanSurface();
};
