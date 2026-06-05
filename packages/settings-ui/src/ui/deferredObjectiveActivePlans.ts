import type {
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING } from '../../../contracts/src/settingsKeys.ts';
import { getSetting } from './homey.ts';
import { bumpPlanSurface } from './planRedesign.ts';
import { state } from './state.ts';

// Browser-safe coercion of the raw `deferred_objective_active_plans` setting.
// The authoritative deep normaliser lives in `lib/objectives/**` (runtime
// backend) and the settings UI must not import across that architecture
// boundary, so this performs the lightweight top-level shape guard the UI
// consumers rely on: `plansByDeviceId` must be an object keyed by device id.
// Per-plan field access in `PlanDeviceCards`/`deadlinePlan` is already optional-
// chained, so a missing/extra leaf field degrades gracefully rather than
// throwing. Anything that is not a `{ plansByDeviceId: object }` blob (absent,
// malformed, or a transient empty SDK read) coerces to `null`, matching the
// recorder's permissive boot load.
export const coerceDeferredObjectiveActivePlans = (
  raw: unknown,
): DeferredObjectiveActivePlansV1 | null => {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { version?: unknown; plansByDeviceId?: unknown };
  if (!candidate.plansByDeviceId || typeof candidate.plansByDeviceId !== 'object') return null;
  return {
    version: 1,
    plansByDeviceId: candidate.plansByDeviceId as Record<string, DeferredObjectiveActivePlanV1>,
  };
};

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
