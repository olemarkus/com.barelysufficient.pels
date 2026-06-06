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
  formatPlanHistoryObservedCoverage,
  formatPlanHistoryOvershootLine,
  formatPlanHistoryPostmortem,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeLabel,
  type DeferredPlanHistoryPostmortem,
} from '../../../shared-domain/src/deferredPlanHistory.ts';
import {
  formatPlanHistoryAbandonedDetails,
  formatPlanHistoryCostNarrative,
  formatPlanHistoryReceiptTimeline,
  formatPlanHistoryShortfallChip,
  type PlanHistoryAbandonedDetails,
  type PlanHistoryReceiptRow,
} from '../../../shared-domain/src/deferredPlanHistoryReceipt.ts';
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
  // Whether the hero is the quiet abandoned-shape — eyebrow + one sentence
  // + Material `<details>` expansion, no chart card, no recourse. Resolved
  // here so the view layer never branches on outcome to drop the chart
  // card. True for `abandoned` / `replaced`, and for `unknown` entries with
  // no recorded plan. `unknown` entries that carry a plan flip this to
  // false so the chart renders as evidence (still collapsed by default via
  // `chartCollapsedByDefault: true`). v2.7.3 + v2.9.x.
  quietAbandoned: boolean;
  // Three-row receipt timeline rendered beneath the outcome line on
  // Succeeded heroes. `null` on Missed / Abandoned, and on Succeeded
  // entries where fewer than two rows could be composed honestly. v2.7.3.
  receiptTimeline: PlanHistoryReceiptRow[] | null;
  // Blameless shortfall summary chip rendered beneath the diagnosis sentence
  // on Missed heroes. `null` on Succeeded / Abandoned, and on Missed
  // entries that lack the delivery / shortfall numbers to summarize. v2.7.3.
  shortfallChip: string | null;
  // Cost narrative chip ("≈ 12 kr") rendered on Succeeded and Missed
  // heroes. `null` on Abandoned, and on entries that didn't capture a
  // total cost or unit. v2.7.3 — the per-kWh average half was dropped
  // pending per-hour spot prices (P1 #4 fold-in).
  costNarrative: string | null;
  // Body of the abandoned-shape `<details>` disclosure. `null` on Succeeded
  // / Missed, and on Abandoned entries that lack enough recorded context to
  // populate the disclosure honestly — in that case the hero stays a
  // single sentence with no expansion control. v2.7.3.
  abandonedDetails: PlanHistoryAbandonedDetails | null;
  // Legacy supporting paragraphs. v2.7.3 suppresses them on Succeeded
  // (receipt timeline carries the same info) and on Abandoned (the
  // `<details>` disclosure is the evidence surface). On Missed,
  // progressLine + coverageLine are suppressed (shortfall chip + diagnosis
  // already answer "by how much" and "how much we observed"), but
  // reachedAtLine and overshootLine survive because they encode signal the
  // chip doesn't (time-to-target / overshoot temperature).
  progressLine: string | null;
  reachedAtLine: string | null;
  overshootLine: string | null;
  coverageLine: string | null;
};


export type BuildHistoryDetailHeroParams = {
  entry: DeferredObjectivePlanHistoryEntry;
  timeZone: string;
  // Heading timestamp pre-formatted by the caller (e.g. `Sat 16 May 16:00`).
  // Kept off the entry so the producer stays free of locale helpers.
  deadlineLine: string;
};

export const buildHistoryDetailHero = (
  params: BuildHistoryDetailHeroParams,
): DeadlinePlanHistoryHeroPayload => {
  const { entry, timeZone, deadlineLine } = params;
  const lead = formatPlanHistoryPostmortem(entry, timeZone);
  const lastPlan = entry.finalPlan ?? entry.originalPlan;
  const dailyBudgetExhausted = typeof lastPlan?.dailyBudgetExhaustedBucketCount === 'number'
    && lastPlan.dailyBudgetExhaustedBucketCount > 0;
  const heading = {
    deviceName: entry.deviceName ?? null,
    deadlineLine,
  };

  const chipLabel = getPlanHistoryOutcomeLabel(entry.outcome);
  const costNarrative = formatPlanHistoryCostNarrative(entry);
  // Pre-resolve the legacy supporting lines once so the per-outcome blocks
  // can selectively keep them or null them. The producer suppresses the
  // ones that duplicate the new receipt / shortfall / cost-narrative
  // surface per `notes/smart-task-ui/README.md` v2.7.3 history-loveable
  // pass. progressLine is retired on every outcome shape;
  // reachedAtLine + overshootLine survive on Missed.
  //
  // coverageLine was retired in v2.7.3 as "plumbing noise" when its semantics
  // were time-based ("Brief gap (Xm)") and the line collapsed to null on the
  // common ≥99 %-observed case. The helper's v2.9.x rewrite ("Observed N of M
  // scheduled hours") flips the actionable case (N=0, M>0 — planner thought the
  // device was active but it never drew power) from invisible to visible, so
  // the line now carries real signal on every outcome shape and earns its
  // place back on the hero.
  const reachedAtLine = formatPlanHistoryReachedAtLine(entry, timeZone);
  const overshootLine = formatPlanHistoryOvershootLine(entry);
  const coverageLine = formatPlanHistoryObservedCoverage(entry);
  if (entry.outcome === 'met') {
    return {
      tone: 'good',
      chip: { text: chipLabel, tone: 'good' },
      eyebrow: SMART_TASK_HISTORY_EYEBROW,
      heading,
      lead,
      // The 3-row receipt below the outcome headline is the new primary
      // supporting line on Succeeded (v2.7.3 history-loveable pass). Cost
      // moves to the `costNarrative` chip; the old kWh-delivered figure is
      // carried inside the receipt's "Largest planned hour" detail. The
      // secondary line is suppressed entirely so the receipt + chip aren't
      // shouted over by a duplicate cost-and-delivered sentence.
      secondary: null,
      whyLine: null,
      recourse: null,
      chartCollapsedByDefault: true,
      quietAbandoned: false,
      receiptTimeline: formatPlanHistoryReceiptTimeline(entry, timeZone),
      shortfallChip: null,
      costNarrative,
      abandonedDetails: null,
      // v2.7.3 — Succeeded retires progressLine / reachedAtLine.
      // The receipt timeline's "Started …", "Largest planned hour …", "Ready
      // 06:42, 18 min before 07:00" rows already encode the same information;
      // stacking them again was the density problem `pels-ux-fit` flagged.
      // coverageLine returns in v2.9.x with its actionable "N of M scheduled
      // hours" rewrite — see the helper resolution above.
      //
      // v2.9.x batch 47 — `overshootLine` is the exception. The receipt
      // timeline answers "what happened" but never names the final reading; a
      // Succeeded run that overshot by > 5 °C / > 10 % (e.g. the lived-state
      // `29.3 → 77.7 °C · target 65 °C` regression in `TODO.md` ~L2724) reads
      // as a normal success without it. The producer resolves `null` for runs
      // that stayed within the threshold, so the line stays quiet on the
      // common path and only surfaces when the user needs to spot a tuning
      // problem. Muted styling carries the "informational, not alarming"
      // intent (per the TODO rationale: passive support-cost reduction).
      progressLine: null,
      reachedAtLine: null,
      overshootLine,
      coverageLine,
    };
  }
  if (entry.outcome === 'missed') {
    const missedShortfallChip = formatPlanHistoryShortfallChip(entry);
    // v2.7.3 P2 fold-in (copilot CusK5 / codex Cuwrx) — gate the cost+delivered
    // secondary behind the absence of both the shortfall chip and the cost
    // narrative. Both new chips encode the same cost/delivery signal at
    // whole-kroner precision; rendering the secondary alongside them double-
    // surfaces the figure at 2-decimal precision and pushes the recourse
    // CTA lower on 320 px screens. The fallback only fires for sparsely-
    // recorded misses where the chips can't compose.
    const missedSecondary = missedShortfallChip === null && costNarrative === null
      ? formatPlanHistoryCostAndDelivered(entry, ' partial')
      : null;
    return {
      tone: 'warn',
      chip: { text: chipLabel, tone: 'warn' },
      eyebrow: SMART_TASK_HISTORY_EYEBROW,
      heading,
      lead,
      secondary: missedSecondary,
      // Why: the missed-reason resolver returns a longer, action-oriented
      // sentence; the postmortem returns a tight outcome-shaped one. Both
      // are useful — the postmortem answers "what happened" and the Why
      // answers "why and what should I do".
      whyLine: formatPlanHistoryMissedReason(entry),
      recourse: resolveMissedHistoryRecourse({
        outcome: entry.outcome,
        dailyBudgetExhausted,
        deviceId: entry.deviceId,
      }),
      chartCollapsedByDefault: false,
      quietAbandoned: false,
      receiptTimeline: null,
      shortfallChip: missedShortfallChip,
      costNarrative,
      abandonedDetails: null,
      // v2.7.3 — Missed retires progressLine; the shortfall chip already
      // answers "by how much, in kWh". reachedAtLine + overshootLine
      // survive because they carry time / temperature signal the chip
      // doesn't. coverageLine returns in v2.9.x — the "N of M scheduled hours"
      // rewrite makes the planned-but-unobserved case (e.g. EV plugged in but
      // never drew power) actionable on the miss diagnosis, which the
      // shortfall chip alone doesn't explain.
      progressLine: null,
      reachedAtLine,
      overshootLine,
      coverageLine,
    };
  }
  // Abandoned / replaced / unknown → quiet log shape (v2.7.3). The page
  // collapses to eyebrow + outcome sentence + Material `<details>`. No
  // chart card by default, no recourse — the temptation to "make it
  // useful" is exactly what makes archives feel like audits.
  //
  // Exception (v2.9.x — TODO from PR #887 copilot reviewer): `unknown`
  // outcomes that carry a recorded plan (originalPlan / finalPlan) flip
  // `quietAbandoned: false` so the view re-renders the chart card as
  // evidence ("a plan WAS made, we just don't know if it ran"). The card
  // stays collapsed by default so the muted "we don't know what happened"
  // semantics survive — the user opts in via the same "View details"
  // toggle Succeeded uses. `abandoned` / `replaced` keep the quiet shape:
  // the user-initiated swap is the answer, not a plan diagnosis.
  const abandonedDetails = formatPlanHistoryAbandonedDetails(entry, timeZone);
  const hasRecordedPlan = entry.originalPlan !== null || entry.finalPlan !== null;
  const showChartForUnknown = entry.outcome === 'unknown' && hasRecordedPlan;
  return {
    tone: 'muted',
    chip: { text: chipLabel, tone: 'muted' },
    eyebrow: SMART_TASK_HISTORY_EYEBROW,
    heading,
    lead,
    // The abandoned shape uses the `<details>` body as its evidence
    // surface — keep the secondary line null so the hero stays a single
    // sentence above the disclosure. Legacy entries without a details
    // payload fall through to the existing `formatPlanHistoryAbandonedSecondary`
    // for partial-delivery context.
    secondary: abandonedDetails === null
      ? formatPlanHistoryAbandonedSecondary(entry)
      : null,
    whyLine: null,
    recourse: null,
    chartCollapsedByDefault: true,
    quietAbandoned: !showChartForUnknown,
    receiptTimeline: null,
    shortfallChip: null,
    costNarrative: null,
    abandonedDetails,
    // Quiet abandoned shape — the `<details>` body is the evidence surface;
    // legacy paragraphs would re-shout details the disclosure already
    // contains. coverageLine stays suppressed on every variant of this
    // shape: `abandoned` / `replaced` are intentionally quiet, and the
    // `unknown`-with-plan branch already renders the chart card whose
    // green observed-scatter dots above each planned bucket visually
    // encode the same N-of-M shape. Surfacing the text on top of the
    // chart would double-shout the same signal.
    progressLine: null,
    reachedAtLine: null,
    overshootLine: null,
    coverageLine: null,
  };
};
