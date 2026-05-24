# Postmortem chart-visibility policy (active vs historic)

> Status: shipped via the v2.7.2 train; `recordHourlyDelivery` is wired in
> production as of `ec60f06f` (v2.8.0). Reference doc for the
> active-vs-historic asymmetry the smart-task pages enforce.

## TL;DR

| Page | Chart default | Why |
|------|---------------|-----|
| Active deadline-plan (`DeadlinePlan.tsx`) | always-on, not toggleable | The chart **is** the answer: "what is going to happen in the next hours?" |
| Historic detail (`DeadlinePlanHistoryDetail.tsx`), outcome=Succeeded | collapsed by default; expand on "View details" | The receipt **is** the answer ("hit 65 °C at 14:32, 28 min before deadline"). The chart is supporting evidence. |
| Historic detail, outcome=Missed | expanded by default; no toggle | The diagnosis needs the chart shape inline ("plan went flat in the last 2 h"). |
| Historic detail, outcome=Abandoned / Replaced (v2.7.3) | **no chart card at all**; Material `<details>` body for on-demand evidence | The user-initiated swap is the answer, not a plan diagnosis. Eyebrow + one sentence + disclosure. |
| Historic detail, outcome=Unknown, **plan was recorded** (v2.9.x) | collapsed by default; expand on "View details" — same shape as Succeeded | A plan WAS made; we just don't know if it ran. The chart is the only available evidence, so we offer it on demand without overriding the muted "we don't know what happened" semantics. |
| Historic detail, outcome=Unknown, **no plan recorded** (v2.9.x) | **no chart card at all** — same shape as Abandoned | Nothing to draw. Backfill-synthesized entries always land here. |

The producer-side flag backing this table is `chartCollapsedByDefault`
(Succeeded=true, Missed=false, Abandoned=true, Replaced=true, Unknown=true),
resolved in
`packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`. The view
layer never branches on outcome — it consumes the flat boolean. Abandoned
and Replaced additionally carry `quietAbandoned: true` so the view drops
the chart card section entirely (the boolean alone doesn't disambiguate
"collapsed chart card with a toggle" from "no chart card at all").

`unknown` outcomes split on the presence of `originalPlan` /
`finalPlan` provenance: with a recorded plan they flip
`quietAbandoned: false` (chart card renders, collapsed by default); without
a plan they keep `quietAbandoned: true` (no chart card). Discriminator is
"plan present" not "outcome value" — copilot reviewer finding on PR #887,
resolved in v2.9.x.

## v2.7.3 history-loveable additions

Three asymmetric hero affordances were folded in on top of the chart policy:

- **Succeeded — 3-row receipt timeline.** Producer
  `formatPlanHistoryReceiptTimeline` resolves up to three rows (`Started`,
  `Cheapest planned hour`, `Ready`) from `progressSamples`, the largest
  recorded planned hour, and `metAtMs`/`deadlineAtMs`. Suppressed when
  fewer than two rows can be composed honestly — a one-row "timeline"
  reads as a fragmentary log. Rendered beneath the outcome headline.
- **Missed — shortfall chip.** `formatPlanHistoryShortfallChip` emits a
  blameless one-line summary ("Delivered 17 of 24 kWh · short ~23 min.")
  rendered in the muted chip primitive (never red). Lives next to the
  existing diagnosis sentence so the user reads "what" and "how short"
  in sequence.
- **Cost narrative chip (Succeeded + Missed).** `formatPlanHistoryCostNarrative`
  emits whole-kroner totals ("≈ 12 kr · 1.20 kr/kWh on average."). The
  v2.7.3 spec sketched a "% under peak" framing; history entries don't
  carry per-hour spot prices today, so the producer emits the honest
  per-kWh average instead of fabricating a peak comparison.
- **Abandoned — quiet `<details>`.** `formatPlanHistoryAbandonedDetails`
  composes the disclosure body (delivered kWh + last device state). The
  view layer renders a Material `<details>` element with an Android
  chevron summary; no chart card, no recourse, no second sentence.

All four helpers live in `packages/shared-domain/src/deferredPlanHistoryReceipt.ts`
so the runtime log breadcrumbs can read the same strings (per
`feedback_ui_text_shared_with_logs.md`).

## v2.7.3 past-tasks list — weekly archive

`groupPlanHistoryByIsoWeek` (same file) groups the past-tasks list into
ISO-week sections. Each section renders a quiet heading
("Week 20 · 4 deadlines met · ≈ 41 kr.") above the existing card list.
The grouping uses ISO-8601 week numbering anchored to the user's time
zone so a Sunday-night deadline in Europe doesn't shift to the previous
ISO week the UTC date would imply. Cost roll-up suppresses cleanly when
the cost-unit suffix is empty (the past-tasks list mount doesn't fetch a
display unit today; the section heading still renders the met-count
fragment).

## Why the asymmetry

The two pages answer different questions:

- **Active** answers "what is the plan?" The chart is a planning instrument; hiding it would defeat the page's reason for existing.
- **Historic** answers "what was the outcome of this run?" The one-sentence outcome headline (`hero.lead.sentence`, producer-resolved in `packages/shared-domain/src/deferredPlanHistory.ts`) is the page's primary content. The chart serves evidence/diagnosis, not framing.

Treating them symmetrically (chart-on-default everywhere) hides the outcome under a chart on succeeded runs — the chart is the loudest element by area, and the user looking up a past run wants the receipt first, the chart only if they're auditing.

## Toggle copy: "View details" / "Hide details" (NOT "View schedule")

The toggle was renamed in PR10 from "View schedule" → "View details" because:

1. "Schedule" is the live deadline-plan page's vocabulary — using it on the historic detail page overloads the noun.
2. The expanded view doesn't just show "the schedule" — it shows the scheduled-vs-observed comparison chart *plus* the per-revision log (gated on the same toggle, per the `RevisionsCard` comment in `DeadlinePlanHistoryDetail.tsx`). "Details" is the honest umbrella term for that grouping.

## Outcome headline styling

PR10 promoted `hero.lead.sentence` from a muted-supporting paragraph
(`<p class="plan-history-detail__postmortem">`, font-size base, font-weight
medium) to a display-tier headline
(`<p class="plan-history-detail__outcome-headline">`, display-tier tokens —
`--pels-text-display-font-size`, `--pels-text-display-font-weight`,
`--pels-text-display-font-line-height`).

The element kept its position inside the hero card, immediately after the
`<header>` that carries the device-name + when. The supporting lines that
explain the outcome (cost + delivered, "Why" diagnosis, recourse CTA,
progress line) follow it, so the reading order is
headline → supporting → chart.

The headline now reads at visual parity with the live deadline-plan page's
main hero headline (`.plan-hero__headline`), so the outcome sentence carries
the same content-importance signal across both pages.
