import type {
  OverviewDeferredObjectiveActivePlan,
  OverviewDeferredObjectiveActivePlans,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING } from '../../../contracts/src/settingsKeys.ts';
import {
  normalizeDeferredObjectiveActivePlansShape,
} from '../../../shared-domain/src/deferredObjectiveActivePlanShape.ts';
import { getSetting } from './homey.ts';
import { bumpPlanSurface } from './planRedesign.ts';
import { state } from './state.ts';

// Narrow per-device predicate for the Overview view. The settings UI has no
// access to the runtime's deep `isActivePlan` validator (the `settings-ui ↛ lib`
// architecture boundary forbids importing it), so here a plan is "valid enough"
// when it is a non-null object — the Overview EV-state line reads only
// `latest.hours` and `diagnosticReasonCode` via optional-chaining. This still
// drops a non-object entry (e.g. a tampered `plansByDeviceId['ev-1'] = 7`) that
// the previous pass-through copy would have kept.
const isOverviewPlanShaped = (plan: unknown): plan is OverviewDeferredObjectiveActivePlan => (
  Boolean(plan) && typeof plan === 'object' && !Array.isArray(plan)
);

// Browser-safe coercion of the raw `deferred_objective_active_plans` setting.
// The authoritative deep normaliser lives in `lib/objectives/**` (runtime
// backend) and the settings UI must not import across that architecture
// boundary, so it delegates the shared top-level shape/version guard
// (`normalizeDeferredObjectiveActivePlansShape` in shared-domain) and supplies
// the narrow Overview per-device predicate above. The shared guard enforces the
// version check and per-device filtering the UI previously skipped, and the sole
// consumer (`PlanDeviceCards` EV-state line) reads only `latest.hours` and
// `diagnosticReasonCode` via optional-chaining, so this returns the narrow
// `OverviewDeferredObjectiveActivePlans` view — value columns are deliberately
// unreachable here. Anything that is not a `{ version, plansByDeviceId: object }`
// blob (absent, malformed, version-mismatched, or a transient empty SDK read)
// coerces to `null` (the UI's empty fallback). The runtime recorder rejects the
// same shapes via the shared guard but degrades to an empty envelope rather than
// `null` — both refuse the blob; only the per-surface empty value differs.
export const coerceDeferredObjectiveActivePlans = (
  raw: unknown,
): OverviewDeferredObjectiveActivePlans | null => normalizeDeferredObjectiveActivePlansShape(raw, {
  isValidPlan: isOverviewPlanShaped,
  empty: () => null,
});

// Re-read the persisted active-plans setting into `state` and repaint the
// overview plan surface. Wired into the `settings.set`/`settings.unset` realtime
// handlers: the recorder persists every replan/session change via
// `homey.settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, …)`, which fires
// the realtime event this drains so the Overview device-card EV state line
// reflects revised schedules without a WebView reload. The handler has already
// invalidated the settings cache for the key, so `getSetting` performs a fresh
// Homey read. Note: the raw persisted setting carries the committed schedule
// fields the overview cards read (`latest.hours`, `diagnosticReasonCode`) but
// not the live-progress fields the bootstrap assembler stitches on — those are
// only needed by the deadline-plan detail surface, which re-fetches the full
// bootstrap on navigation.
//
// A burst of rapid `settings.set` events (e.g. several replans landing close
// together) can launch overlapping reads. `getSetting` is async, so without a
// guard an earlier read resolving after a later one would clobber `state` with
// stale data. The monotonic sequence counter makes the write last-wins: only
// the most recently launched read is allowed to commit.
let reloadSequence = 0;
export const reloadDeferredObjectiveActivePlans = async (): Promise<void> => {
  reloadSequence += 1;
  const sequence = reloadSequence;
  const raw = await getSetting(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING);
  if (sequence !== reloadSequence) return;
  state.deferredObjectiveActivePlans = coerceDeferredObjectiveActivePlans(raw);
  bumpPlanSurface();
};
