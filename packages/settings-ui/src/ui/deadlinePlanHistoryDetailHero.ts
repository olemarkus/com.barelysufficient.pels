// Producer for the smart-task history-detail hero payload. Mirrors the
// pattern of `deadlinePlanHero.ts` for the live hero: resolves a single
// pre-baked payload object (`tone`, `lead`, `secondary`, `recourse`,
// `chartCollapsedByDefault`) so the view layer never branches on the
// outcome / planStatus / `dailyBudgetExhaustedBucketCount`.
//
// Page mission per `notes/smart-task-ui/README.md`:
//   - Succeeded → receipt: did it work, at what cost?
//   - Missed    → diagnosis + recourse: why, and what do I do next?
//   - Abandoned → log: when did it stop, with minimal context.
//
// Per `feedback_layering_resolution_in_producer.md` — all conditional
// composition lives here; the view's only branches are on the resolved
// `tone` and the presence/absence of optional fields.
import type {
  DeferredObjectivePlanHistoryEntry,
} from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import {
  formatPlanHistoryAbandonedSecondary,
  formatPlanHistoryCostAndDelivered,
  formatPlanHistoryMissedReason,
  formatPlanHistoryPostmortem,
  getPlanHistoryOutcomeLabel,
  type DeferredPlanHistoryPostmortem,
} from '../../../shared-domain/src/deferredPlanHistory.ts';
import {
  type DeadlineCannotMeetRecourse,
  resolveMissedHistoryRecourse,
  SMART_TASK_HISTORY_EYEBROW,
} from '../../../shared-domain/src/deadlineLabels.ts';

// Tone slug for the history-detail hero shape. Mirrors the live hero's
// `DeadlinePlanHeroTone` partially — the history surface only ever resolves
// to `good` / `warn` / `muted` (no `info` / `alert`). Kept as its own union
// so the live `info` / `alert` tones can't accidentally leak into the
// history surface and contradict the postmortem's narrative. Tone slugs
// match `deadlinePlanHero.ts` so the existing `.plan-hero[data-tone="…"]`
// CSS rim rules can apply to both surfaces.
export type DeadlinePlanHistoryHeroTone = 'good' | 'warn' | 'muted';

export type DeadlinePlanHistoryHeroPayload = {
  // Resolved CSS rim tone. View applies `data-tone={tone}` on the hero
  // section — same binding as the live hero.
  tone: DeadlinePlanHistoryHeroTone;
  // Outcome chip label and CSS variant — pre-resolved so the view never
  // branches on `outcome` directly. The label is the same one the list
  // surface renders, so the user reads the same word twice ("Succeeded" →
  // "Succeeded" header, etc.) without us inventing alternative copy.
  chip: { text: string; tone: DeadlinePlanHistoryHeroTone };
  // Eyebrow / scoping label above the heading. Always "Smart task" today;
  // kept on the payload so future kind-aware variants don't need a view
  // change.
  eyebrow: string;
  // Heading line (h1). Split into device name (primary subject) and
  // deadline timestamp (de-emphasized) so the view can render the timestamp
  // with the existing `.plan-history-detail__heading-when` muted-tone CSS.
  // `deviceName` is null when no device name was recorded; the view collapses
  // the heading to just the timestamp in that case.
  heading: {
    deviceName: string | null;
    deadlineLine: string;
  };
  // One-sentence postmortem from `formatPlanHistoryPostmortem`. The
  // variant slug is carried on the payload for analytics / log
  // breadcrumbs; the view only renders `lead.sentence`.
  lead: DeferredPlanHistoryPostmortem;
  // Cost + delivered / partial / abandoned-by-then secondary line. Pre-
  // composed so the view doesn't branch on the entry's `deliveredKWh` /
  // `totalCost` optional fields. Null when there's nothing concrete to
  // say (legacy entries without delivery contributions).
  secondary: string | null;
  // For the Missed shape only: the bare "Why" sentence sourced from
  // `formatPlanHistoryMissedReason`. Surfaced separately from the
  // postmortem so the hero can render `Why: …` distinct from the
  // postmortem's outcome-shaped sentence. Null on Succeeded / Abandoned
  // (and on Missed when the resolver short-circuits — see helper).
  whyLine: string | null;
  // Recourse CTA from `resolveMissedHistoryRecourse`. Null on Succeeded
  // and Abandoned so the view never renders a button on those shapes.
  recourse: DeadlineCannotMeetRecourse | null;
  // Whether the comparison chart card defaults to collapsed. Succeeded =
  // receipt-shape (collapsed by default with a "View plan" toggle); Missed
  // = diagnosis-shape (always expanded); Abandoned = muted log (collapsed).
  chartCollapsedByDefault: boolean;
};


export type BuildHistoryDetailHeroParams = {
  entry: DeferredObjectivePlanHistoryEntry;
  timeZone: string;
  // Heading timestamp pre-formatted by the caller (e.g. `Sat 16 May 16:00`).
  // Kept off the entry so the producer stays free of locale helpers.
  deadlineLine: string;
  // Cost unit suffix for the secondary line (e.g. `kr`). Empty / null
  // suppresses the cost half of the secondary line — Flow / Homey schemes
  // without a unit don't fabricate one.
  costUnit: string;
};

export const buildHistoryDetailHero = (
  params: BuildHistoryDetailHeroParams,
): DeadlinePlanHistoryHeroPayload => {
  const { entry, timeZone, deadlineLine, costUnit } = params;
  const lead = formatPlanHistoryPostmortem(entry, timeZone);
  const lastPlan = entry.finalPlan ?? entry.originalPlan;
  const dailyBudgetExhausted = typeof lastPlan?.dailyBudgetExhaustedBucketCount === 'number'
    && lastPlan.dailyBudgetExhaustedBucketCount > 0;
  const heading = {
    deviceName: entry.deviceName ?? null,
    deadlineLine,
  };

  const chipLabel = getPlanHistoryOutcomeLabel(entry.outcome);
  if (entry.outcome === 'met') {
    return {
      tone: 'good',
      chip: { text: chipLabel, tone: 'good' },
      eyebrow: SMART_TASK_HISTORY_EYEBROW,
      heading,
      lead,
      secondary: formatPlanHistoryCostAndDelivered(entry, costUnit, ''),
      whyLine: null,
      recourse: null,
      chartCollapsedByDefault: true,
    };
  }
  if (entry.outcome === 'missed') {
    return {
      tone: 'warn',
      chip: { text: chipLabel, tone: 'warn' },
      eyebrow: SMART_TASK_HISTORY_EYEBROW,
      heading,
      lead,
      secondary: formatPlanHistoryCostAndDelivered(entry, costUnit, ' partial'),
      // Why: the missed-reason resolver returns a longer, action-oriented
      // sentence; the postmortem returns a tight outcome-shaped one. Both
      // are useful — the postmortem answers "what happened" and the Why
      // answers "why and what should I do".
      whyLine: formatPlanHistoryMissedReason(entry),
      recourse: resolveMissedHistoryRecourse({
        outcome: entry.outcome,
        dailyBudgetExhausted,
      }),
      chartCollapsedByDefault: false,
    };
  }
  // Abandoned / replaced / unknown → muted log shape.
  return {
    tone: 'muted',
    chip: { text: chipLabel, tone: 'muted' },
    eyebrow: SMART_TASK_HISTORY_EYEBROW,
    heading,
    lead,
    secondary: formatPlanHistoryAbandonedSecondary(entry),
    whyLine: null,
    recourse: null,
    chartCollapsedByDefault: true,
  };
};
