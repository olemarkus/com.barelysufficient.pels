# Postmortem chart-visibility policy (active vs historic)

> Status: shipped on `v2.7.2/PR10` (2026-05-17). Source for the active-vs-historic
> asymmetry the smart-task pages enforce.

## TL;DR

| Page | Chart default | Why |
|------|---------------|-----|
| Active deadline-plan (`DeadlinePlan.tsx`) | always-on, not toggleable | The chart **is** the answer: "what is going to happen in the next hours?" |
| Historic detail (`DeadlinePlanHistoryDetail.tsx`), outcome=Succeeded | collapsed by default; expand on "View details" | The receipt **is** the answer ("hit 65 °C at 14:32, 28 min before deadline"). The chart is supporting evidence. |
| Historic detail, outcome=Missed | expanded by default; no toggle | The diagnosis needs the chart shape inline ("plan went flat in the last 2 h"). |
| Historic detail, outcome=Abandoned | collapsed by default; expand on "View details" | The log shape: a finalised event with a partial-delivery summary. The chart is on-demand evidence. |

The producer-side flag backing this table is `chartCollapsedByDefault`
(Succeeded=true, Missed=false, Abandoned=true), resolved in
`packages/settings-ui/src/ui/deadlinePlanHistoryDetailHero.ts`. The view
layer never branches on outcome — it consumes the flat boolean.

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
