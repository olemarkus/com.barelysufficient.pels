// Why a smart task's schedule changed: the per-revision labels and tooltip
// lines the live panel and the history detail share.
import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectiveActivePlanRevisionReason,
} from '../../../contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveSettingsKind } from '../../../contracts/src/deferredObjectiveSettings';

// Shared across all objective kinds — revision reasons are recorder-level
// concepts that don't vary by device category.
export const REVISION_REASON_TOOLTIP_LINE: Partial<Record<DeferredObjectiveActivePlanRevisionReason, string>> = {
  flow_card: 'Updated after a flow card fired',
  prices_arrived: 'Updated as prices became available',
  objective_changed: 'Updated after the target changed',
  direction_changed: 'Updated after thermostat direction changed',
  // Only fires when the planner consumed a newer price horizon than the
  // previous revision. `schedule_revised` carries internal replans.
  prices_revised: 'Updated as new prices arrived',
  // Schedule shifted without a new price horizon — daily-budget pressure
  // moved a bucket, planStatus flipped, etc. Honest about the cause without
  // claiming a publication event.
  schedule_revised: 'Updated as the schedule was revised',
  rate_refined: 'Updated as rates were refined',
  flow_permission_changed: 'Updated after a Flow changed what this smart task may do',
};

// Short "what changed" copy for the per-revision log on the smart-task history
// detail page. Reuses the same `DeferredObjectiveActivePlanRevisionReason` enum
// the recorder emits — strings here are deliberately tighter than
// `REVISION_REASON_TOOLTIP_LINE` (which sits in the live hover tooltip and can
// afford a sentence) because the history-detail surface stacks these in a
// vertical list.
//
// Per `feedback_ui_text_shared_with_logs.md`, copy lives in shared-domain so the
// history-detail view and any log breadcrumb added later render identical
// labels. No runtime module reads this map today.
//
// Reasons absent from this map fall through to `REVISION_REASON_FALLBACK` so
// the view never invents copy for a recorder code it hasn't yet learned about
// — better to surface "Plan refreshed" than to omit the entry entirely (which
// would silently under-count the revision log).
const REVISION_REASON_LABEL: Record<DeferredObjectiveActivePlanRevisionReason, string> = {
  flow_card: 'Updated by a Flow card',
  prices_arrived: 'Prices arrived',
  // Reserved for revisions where the planner saw a fresher price horizon
  // than the previous revision (Nordpool typically publishes 1–2 times per
  // day). Internal replans surface as `schedule_revised` so this label
  // doesn't claim a publication event that didn't happen.
  prices_revised: 'Tomorrow’s prices published',
  schedule_revised: 'Schedule revised',
  rate_refined: 'Rate estimate refined',
  objective_changed: 'Smart task settings changed',
  direction_changed: 'Thermostat direction changed',
  // Per `feedback_homey_sdk_unreliable.md`: a single SDK read miss triggers this
  // reason — the recorder doesn't witness a sustained "offline" state. Copy
  // names the *event the recorder saw* ("couldn't read"), not a state it
  // assumes.
  device_unavailable: 'Device was unreachable',
  // `measured_deviation` fires when the device's learned per-unit energy rate
  // (kWh per °C or per % SoC) drifted far enough from the rate the plan was
  // committed against to trigger a replan. Naming the *cause-effect* (rate
  // differed → replan) reads more clearly than naming an abstract field
  // ("rate updated", which leaves the user asking which rate).
  measured_deviation: 'Measured rate differed from plan',
  // A Flow toggled a rescue permission (exempt-from-budget etc.), so PELS re-solved
  // under the new limits. Names the action the user took, per the transparency rule.
  flow_permission_changed: 'Flow changed what this smart task may do',
};

const REVISION_REASON_FALLBACK = 'Plan refreshed';

// View-facing fallback variant used when a row template wants to make the
// absent diff chip self-explanatory. `REVISION_REASON_FALLBACK` is the
// producer label (used for the live-panel summary line, and the terser variant
// any later log breadcrumb should read); the row templates on both the
// live-task panel and the post-finalization history-detail card render this
// longer variant when `isFallback === true` so the user understands why the
// row carries no `+/−Nh` chip. Per `feedback_ui_text_shared_with_logs.md`,
// view layers consume it from shared-domain rather than inlining the copy.
export const REVISION_REASON_FALLBACK_WITH_DETAIL = 'Plan refreshed (details unavailable)';

// Title for the live-task revision panel `<summary>` on the smart-task detail
// page. The "plan" noun is intentional here — this is the planning-layer
// revision panel, which `notes/ui-terminology.md` § "Plan vs deadline" sanctions
// (the reservation governs the user-facing schedule entity, not the planner's
// own surfaces). Sourced from shared-domain so a log breadcrumb added later
// renders the identical string rather than restating it; no runtime module
// reads it today (per `feedback_ui_text_shared_with_logs.md`).
export const REVISION_PANEL_TITLE = 'Recent plan changes';

// Optional disambiguation signals for `schedule_revised`. When the live-task
// surface passes these in, `resolveRevisionReason` returns a more specific label
// instead of the bare `Schedule revised`. History-detail rows don't carry these
// signals on their entry shape (see
// `DeferredObjectivePlanHistoryRevisionLogEntry`) so they continue to render
// the bare label — and that's fine; the active panel is the surface where
// "why now?" matters most.
//
// All fields optional individually so callers can supply only what they have.
// The producer resolves precedence; consumers never branch on which signal
// drove the variant.
export type RevisionReasonDisambiguation = {
  // True when the prior revision's planStatus differed from this revision's.
  // Drives the `risk changed` variant when no budget / hour-add signal applies.
  planStatusChanged?: boolean;
  // Producer-resolved verdict on what bound the floor schedule: the only
  // budget signal a revision carries.
  floorShortfallCause?: DeferredObjectiveActivePlanFloorShortfallCause;
  // Hour-diff symmetric-difference counts vs the prior revision. Drives the
  // `cheaper hour opened` variant when hours grew without budget pressure.
  hoursAdded?: number;
  hoursRemoved?: number;
};

const SCHEDULE_REVISED_BASE = 'Schedule revised';
// Em-dash separator (U+2014) to match the typographic dash used elsewhere in
// the smart-task UI for `…—…` clauses.
const SCHEDULE_REVISED_BUDGET = `${SCHEDULE_REVISED_BASE} — daily budget shifted`;
const SCHEDULE_REVISED_RISK = `${SCHEDULE_REVISED_BASE} — risk changed`;
const SCHEDULE_REVISED_OPENED = `${SCHEDULE_REVISED_BASE} — cheaper hour opened`;

// Precedence for `schedule_revised` disambiguation. Budget is the strongest
// signal (the most actionable explanation for the user — "your daily budget
// caused the shift, here's how to relieve it"), then planStatus transition
// (risk story), then hour-add (optimizer found new affordable space). Falls
// through to the bare label when none of the signals are conclusive — better
// to under-promise than to mislabel.
const resolveScheduleRevisedLabel = (
  d: RevisionReasonDisambiguation,
): string => {
  if (d.floorShortfallCause === 'budget') return SCHEDULE_REVISED_BUDGET;
  if (d.planStatusChanged === true) return SCHEDULE_REVISED_RISK;
  const added = typeof d.hoursAdded === 'number' ? d.hoursAdded : 0;
  const removed = typeof d.hoursRemoved === 'number' ? d.hoursRemoved : 0;
  if (added > 0 && removed === 0) return SCHEDULE_REVISED_OPENED;
  return SCHEDULE_REVISED_BASE;
};

// Resolved short-label record for a revision-reason code.
//
//   `label`        the short "what changed" copy. Always a non-empty string;
//                  unknown / falsy reason codes fall through to
//                  `REVISION_REASON_FALLBACK` so the view never has to invent
//                  copy for a recorder code it hasn't learned about.
//   `isFallback`   true when the reason code was unknown / falsy and the
//                  fallback label was used. Consumers can use this to suppress
//                  the hour-diff chip (the chip would otherwise misattribute
//                  the diff to a "Plan refreshed" line that says nothing about
//                  why hours changed), or to emit a one-shot logging
//                  breadcrumb so the gap gets noticed.
export type ResolvedRevisionReason = {
  label: string;
  isFallback: boolean;
};

// Resolves the per-revision label plus a structural `isFallback` flag for
// consumers that want to treat unknown-code rows differently. See the
// `ResolvedRevisionReason` doc for the contract.
//
// `kind` is accepted so callers (heating vs EV) can pass it without branching
// at the call site — the underlying copy is kind-agnostic today because
// revision causes are recorder-level events (a price publish is a price
// publish regardless of device category). The parameter name is prefixed `_`
// to reserve the slot for future kind-aware copy without churning every
// caller.
//
// `disambiguation` is honored only when `reasonId === 'schedule_revised'`;
// other reason codes already carry enough signal in the code itself. A caller
// without the disambiguation signals (history-detail entries, and any log
// breadcrumb added later) omits the third arg and gets the bare
// `Schedule revised` — the same string they got before this resolver
// learned to disambiguate.
export const resolveRevisionReason = (
  reasonId: string | null | undefined,
  _kind: DeferredObjectiveSettingsKind,
  disambiguation?: RevisionReasonDisambiguation,
): ResolvedRevisionReason => {
  if (!reasonId) return { label: REVISION_REASON_FALLBACK, isFallback: true };
  if (Object.prototype.hasOwnProperty.call(REVISION_REASON_LABEL, reasonId)) {
    if (reasonId === 'schedule_revised' && disambiguation) {
      return { label: resolveScheduleRevisedLabel(disambiguation), isFallback: false };
    }
    return {
      label: REVISION_REASON_LABEL[reasonId as DeferredObjectiveActivePlanRevisionReason],
      isFallback: false,
    };
  }
  return { label: REVISION_REASON_FALLBACK, isFallback: true };
};
