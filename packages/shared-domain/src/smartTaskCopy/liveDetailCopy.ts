// Copy for a running smart task's detail page: the schedule and trajectory
// charts, and the hero's cost and delivered-so-far lines.
import type { DeferredObjectiveUnit } from '../../../contracts/src/deferredObjectiveSettings';
import { APPROX_GLYPH, formatProgressValueForUnit } from './valueFormat';

// ─── Energy estimate range (variance buffer) ─────────────────────────────────

// Formats the energy estimate as a range when the planned (buffered) figure
// sits above the expected (mean) figure — PELS books for the high end while the
// rate is still being refined. Collapses to a single "8.0 kWh" when the two
// round equal (steady device, cold-start, or no buffer), so the UI never shows
// a degenerate "8.0–8.0" range. The range itself signals approximation, so no
// `≈` glyph here — unlike a lone planned figure, which needs the hedge.
//
// `energyExpectedKWh` is optional/absent on plans persisted before the variance
// buffer shipped; absent is treated as equal to planned (range collapses).
export const formatEnergyEstimateKWh = (params: {
  energyPlannedKWh: number;
  energyExpectedKWh?: number | null;
}): string => {
  const planned = params.energyPlannedKWh;
  const expected = typeof params.energyExpectedKWh === 'number' ? params.energyExpectedKWh : planned;
  const lowText = expected.toFixed(1);
  const highText = planned.toFixed(1);
  if (lowText === highText || planned <= expected) return `${highText} kWh`;
  return `${lowText}–${highText} kWh`; // en-dash
};

// ─── "Cheapest hours" chart caption ─────────────────────────────────────────

// Caption rendered under the live deadline-plan schedule chart answering the
// skeptical EV-commuter's second-most-asked question (after cost): "is PELS
// actually picking cheaper hours?" The chart already tone-codes the price bars,
// but a single sentence states the result plainly.
//
// Wording deliberately avoids the bare "cheapest" superlative: the allocator
// fills cheapest-first but a committed current hour or a capacity/budget
// constraint can keep a non-cheapest hour in the live set (see
// `lib/objectives/deferredObjectives/bucketAllocation.ts`), so "picked the N
// cheapest" would overclaim optimality the planner doesn't guarantee. Instead
// the caption states the count ("Picked N of the M hours it can use") plus the
// picked hours' average price; the muted unplanned bars directly above carry
// the baseline visually, so no numeric comparison is repeated here. "the M
// hours it can use" names the eligible pool (every charted hour up to the
// deadline) without re-anchoring on the hero's hours-left figure, which counts
// from *now* and can legitimately differ by one.
//
// `unitLabel` is the already-scaled price unit (e.g. `kr/kWh`); the caller
// passes the per-hour display prices already scaled øre→kr via the CostDisplay
// divisor, so this helper only averages + phrases pre-scaled values and never
// re-divides. `plannedPrices` are the display prices of the picked hours;
// `allPrices` are every hour's display price in the window (the eligible pool
// whose size the caption states).
//
// The averaging lives here (not at the caller) so the producer stays a thin
// projection and the trust-caption arithmetic is unit-tested in one place.
//
// Returns `null` when the caption can't be stated honestly — no planned hours,
// fewer than two hours in the window (no real "picking" happened), or a missing
// price unit (Flow / Homey scheme without one). The caller suppresses the line
// rather than render a degenerate "Picked 0 of 1 hours" summary.
type PricedSchedulePeriod = { startsAtMs: number; endsAtMs: number; priceValue: number };

export const formatCheapestHoursCaption = (
  plannedPrices: readonly PricedSchedulePeriod[],
  allPrices: readonly PricedSchedulePeriod[],
  unitLabel: string,
): string | null => {
  const unit = unitLabel.trim();
  if (unit.length === 0 || unit === 'Price' || plannedPrices.length === 0 || allPrices.length < 2) return null;
  const durationMs = plannedPrices.reduce((sum, period) => sum + period.endsAtMs - period.startsAtMs, 0);
  if (durationMs <= 0) return null;
  const average = plannedPrices.reduce((sum, period) => (
    sum + period.priceValue * (period.endsAtMs - period.startsAtMs)
  ), 0) / durationMs;
  const minutes = Math.round(durationMs / 60000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const duration = hours > 0 ? `${hours}h${remainder > 0 ? ` ${remainder}m` : ''}` : `${minutes > 0 ? minutes : '<1'}m`;
  return `Scheduled ${duration} · avg ${average.toFixed(2)} ${unit}`;
};

// ─── Live-page two-chart split copy (schedule + trajectory cards) ────────────
// All strings for the smart-task live page's question-titled charts live here
// so runtime log breadcrumbs and the UI render identical wording (per
// `feedback_ui_text_shared_with_logs.md`) and the view stays a flat renderer
// (per `feedback_layering_resolution_in_producer.md`).

// Card title for the schedule chart. Kind-agnostic — the kind verb lives on
// the trajectory chart's labelled run band ("Heating"/"Cooling"/"Charging" via
// `deviceSeriesName`).
export const SMART_TASK_SCHEDULE_CARD_TITLE = 'When will it run, and at what price?';

// One-line key under the schedule chart decoding its one-hue-two-states bar
// encoding (filled mint = scheduled, dimmed = eligible but not scheduled).
export const SMART_TASK_SCHEDULE_CHART_KEY = 'Filled bars are scheduled · dimmed bars are not scheduled';

// Kind-aware trajectory card title: "Will it reach 65 °C in time?" /
// "Will it reach 80% in time?". The target label is composed from the same
// `formatProgressValueForUnit` the hero lines use so the number can't drift.
export const formatSmartTaskTrajectoryCardTitle = (params: {
  targetValue: number;
  targetUnit: DeferredObjectiveUnit;
}): string => `Will it reach ${formatProgressValueForUnit(params.targetValue, params.targetUnit)} in time?`;

// Pinned-readout helper for a period without a revision sentence. Dragging
// works even when the displayed periods are too narrow for individual taps.
export const SMART_TASK_READOUT_SCRUB_HINT = 'Drag across the chart to read each period';

// Third segment of the readout primary line for an hour with no planned
// energy that is not the current hour.
export const SMART_TASK_READOUT_NOT_SCHEDULED = 'Not scheduled';

// Marker word for the deadline markLine on both live charts. The schedule
// chart appends the resolved "Sun 09:00" form; the trajectory chart uses the
// bare word (on-track) or appends the clock time (danger variant).
export const DEADLINE_MARKER_WORD = 'deadline';

// Marker word for the current hour on both live charts: the schedule chart's
// x-axis label at the now column and (capitalized, time-position) the pinned
// readout's time segment. One constant so the two surfaces can't drift.
export const NOW_MARKER_WORD = 'Now';

// "Target 65.0 °C" / "Target 80%" label on the trajectory chart's dashed
// target line. Composed from the same `formatProgressValueForUnit` the hero
// and stateline use so the number format can't drift.
export const formatSmartTaskTargetLabel = (params: {
  targetValue: number;
  targetUnit: DeferredObjectiveUnit;
}): string => `Target ${formatProgressValueForUnit(params.targetValue, params.targetUnit)}`;

// Primary line of the pinned hour readout under the schedule chart.
// Shapes (all parts pre-resolved by the producer — locale time formatting and
// price scaling never happen here):
//   planned:            heating or cooling kWh planned
//   planned + measured: `… planned · Measured 1.8 kWh`
//   idle current hour:  `Now · 0.42 kr/kWh · Idle — {heating|cooling} starts 08:00`
//   idle current hour, nothing scheduled: `Now · 0.42 kr/kWh · Idle`
//   idle other hour:    `13:00 · 0.62 kr/kWh · Not scheduled`
// The idle current hour must never claim the kind verb as active — the hero
// already says when it starts, so the readout agrees ("Idle — heating starts"
// / "Idle — cooling starts") instead of contradicting it. The third segment is
// capitalized like its siblings ("Not scheduled", "Heating/Cooling … planned");
// the embedded kind verb stays lowercase mid-sentence ("heating starts").
// An hour is planned when it promises energy (`plannedKwh > 0`).
// `nextStartLabel` is the first planned start time ("08:00") when the current
// hour is idle and a run is scheduled later; null when nothing is scheduled.
export const formatSmartTaskHourReadoutPrimary = (
  timeLabel: string,
  priceLabel: string,
  plannedKwh: number,
  kindVerb: string,
  isNow: boolean,
  nextStartLabel: string | null,
  measuredKwh: number | null,
): string => {
  const head = `${timeLabel} · ${priceLabel}`;
  if (plannedKwh > 0) {
    const measured = measuredKwh !== null && measuredKwh > 0
      ? ` · Measured ${measuredKwh.toFixed(1)} kWh`
      : '';
    return `${head} · ${kindVerb} ${plannedKwh.toFixed(1)} kWh planned${measured}`;
  }
  if (isNow) {
    return nextStartLabel !== null
      ? `${head} · Idle — ${kindVerb.toLowerCase()} starts ${nextStartLabel}`
      : `${head} · Idle`;
  }
  return `${head} · ${SMART_TASK_READOUT_NOT_SCHEDULED}`;
};

// Stateline under the trajectory chart. Two variants:
//   ready: `51.1 °C now · on track — projected ready ≈ Sun 02:00, 7 hours before the deadline`
//   short: `Projected 58 °C at the deadline · 7 °C short`
// `emphasis` renders bold + toned; `rest` is the plain remainder (the view
// joins them with ` · `). Composed here so the live UI and runtime logs share
// the exact sentence.
// Structured on-track verdict, hoisted out of the trajectory stateline so the
// detail hero can broadcast "am I on track?" as a status row above the fold —
// the same answer the smart-task list card gives via its status chip — without
// the user scrolling down to read the stateline sentence under the trajectory
// chart.
export type SmartTaskTrajectoryVerdict = {
  // Capitalized chip-vocabulary word ("On track" / "At risk") — the sentence
  // position of the same word the stateline `rest` uses mid-sentence.
  label: string;
  // "projected ready ≈ 21:00, 1 hour before the deadline" — the stateline's
  // own supporting phrase, minus the status-word prefix (which the label
  // carries). One source so the hero row and the stateline can't drift.
  supporting: string;
};

export type SmartTaskTrajectoryStateline = {
  emphasis: string;
  rest: string;
  tone: 'ok' | 'danger';
  // Structured verdict for the hero status row. Populated for BOTH ready-branch
  // statuses that carry a status word (on track / at risk, `statusWord !==
  // null`); null on the danger/short branch and on `invalid` plans, which carry
  // no honest verdict to broadcast. The hero only RENDERS this under the good
  // (on-track/satisfied) tone — the at-risk verdict is resolved but suppressed
  // there because the At-risk chip already carries that state.
  verdict: SmartTaskTrajectoryVerdict | null;
};

// Mid-sentence status words for the ready stateline. Lowercase variants of the
// canonical chip labels (`On track` / `At risk`) — same vocabulary, sentence
// position.
export const SMART_TASK_STATELINE_ON_TRACK_WORD = 'on track';
export const SMART_TASK_STATELINE_AT_RISK_WORD = 'at risk';

// Full word per the terminology rule "full words for time units" — the
// stateline is a sentence, not a chip, so "7 hours" beats "7 h".
const formatHoursBeforeDeadline = (hoursBefore: number): string => {
  if (hoursBefore < 1) return 'just before the deadline';
  // A ready-by safety margin must never promise more time than the projection.
  const rounded = Math.floor(hoursBefore);
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'} before the deadline`;
};

// A level (a temperature, a battery level) reads as "now"; an amount of energy
// is a running total, so it reads as "delivered", matching the hero's
// "Delivered X of Y kWh".
export const formatSmartTaskCurrentValuePhrase = (valueLabel: string, unit: DeferredObjectiveUnit): string => (
  unit === 'kWh' ? `${valueLabel} delivered` : `${valueLabel} now`
);

// `currentValuePhrase` is `formatSmartTaskCurrentValuePhrase` ("48.0 °C now" /
// "2.0 kWh delivered"); `statusWord` the lowercase mid-sentence status word
// ("on track" / "at risk"), or null when no status word applies (the chip above
// carries the capitalized form).
export const formatSmartTaskTrajectoryStatelineReady = (
  currentValuePhrase: string,
  statusWord: string | null,
  readyTimeLabel: string,
  hoursBeforeDeadline: number,
): SmartTaskTrajectoryStateline => {
  // Compose the projected-ready phrase once so the stateline `rest` and the
  // hero status row's `verdict.supporting` render the exact same words.
  const projectedReady = `projected ready ${APPROX_GLYPH} ${readyTimeLabel}, `
    + formatHoursBeforeDeadline(hoursBeforeDeadline);
  // On the on-track branch the hero status row already broadcasts the
  // projected-ready phrase above the fold, so the stateline drops it (keeping
  // just "{value} now · on track") — the phrase must not render verbatim twice
  // on one screen, and the trajectory chart itself shows the projection. The
  // at-risk ready branch has no hero status row (it renders only under the
  // good tone), so its stateline keeps the projected-ready phrase.
  let rest = projectedReady;
  if (statusWord !== null) {
    const isOnTrack = statusWord === SMART_TASK_STATELINE_ON_TRACK_WORD;
    rest = isOnTrack ? statusWord : `${statusWord} — ${projectedReady}`;
  }
  return {
    emphasis: currentValuePhrase,
    rest,
    tone: 'ok',
    verdict: statusWord !== null
      ? {
        label: `${statusWord.charAt(0).toUpperCase()}${statusWord.slice(1)}`,
        supporting: projectedReady,
      }
      : null,
  };
};

// Rounds to the unit's display precision (whole % / one-decimal °C). A
// sub-half-step `shortBy` would round to a zero amount ("0% short"), but the
// only caller (`deadlinePlanTrajectory.ts`) gates the short branch on
// `SHORTFALL_DISPLAY_EPSILON` (0.5 % / 0.05 °C) — exactly the rounding
// half-step — so a flagged shortfall always renders ≥ "1% short" /
// "0.1 °C short". If those epsilons ever shrink below the half-step, clamp
// here instead of trusting the gate.
export const formatSmartTaskTrajectoryShortAmountLabel = (
  shortBy: number,
  unit: DeferredObjectiveUnit,
): string => {
  if (unit === '%') return `${Math.round(shortBy)}% short`;
  const rounded = Math.round(shortBy * 10) / 10;
  const text = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
  return `${text} ${unit} short`;
};

export const formatSmartTaskTrajectoryStatelineShort = (params: {
  projectedValueLabel: string;
  shortAmountLabel: string;
}): SmartTaskTrajectoryStateline => ({
  emphasis: `Projected ${params.projectedValueLabel} at the deadline`,
  rest: params.shortAmountLabel,
  tone: 'danger',
  // No hero status row on the danger branch: the hero already carries the
  // "At risk" / "Cannot finish" chip + reason line, so a green-adjacent
  // "verdict" row here would either duplicate or contradict them.
  verdict: null,
});

// ─── Cost + delivered-so-far hero lines (v2.7.2 PR 2) ────────────────────────

// Resolver for the `Cost ≈ X.XX kr` meta line. The smart-task detail hero
// retired this in favour of the value-only `formatEstimatedCostStatValue`
// (below), but the `create_smart_task` and `starvation_rescue` widgets still
// render this full-sentence form, so it stays a live shared-domain export —
// UI and runtime log breadcrumbs surface the same phrasing
// (`feedback_ui_text_shared_with_logs.md`).
//
// Branches resolve in this order:
//   1. `deliveredCost !== null` AND finite → composite "so far · planned" form.
//   2. Otherwise                            → planned-only form.
//
// Returns `null` when the planned cost cannot be summarised honestly — the
// unit is missing (Flow / Homey scheme with no `priceUnit`) or the planned
// total is non-finite. Zero / negative planned cost still renders (Norwegian
// Nordpool spot prices go negative during oversupply — "you got paid to
// charge" is a real outcome the owner should see).
export const formatDeadlineCostMetaLine = (params: {
  plannedTotalCost: number;
  deliveredCost: number | null;
  costUnit: string;
}): string | null => {
  const unit = params.costUnit.trim();
  if (unit.length === 0) return null;
  if (!Number.isFinite(params.plannedTotalCost)) return null;
  const plannedLabel = `${params.plannedTotalCost.toFixed(2)} ${unit}`;
  if (params.deliveredCost !== null && Number.isFinite(params.deliveredCost)) {
    const deliveredLabel = `${params.deliveredCost.toFixed(2)} ${unit}`;
    return `Cost ${APPROX_GLYPH} ${deliveredLabel} so far · ${plannedLabel} planned`;
  }
  return `Cost ${APPROX_GLYPH} ${plannedLabel}`;
};

// Value-only estimated-cost figure for the smart-task hero stat pair
// ("Estimated cost" / "≈ 3.10 kr"). The label lives on the stat pair, so this
// returns just the approximated planned amount (unlike the full-sentence
// `formatDeadlineCostMetaLine` the widgets use). Returns null when the cost
// can't be summarised honestly — a missing cost unit (Flow / Homey scheme
// without `priceUnit`) or a non-finite planned total — so the caller drops the
// stat cleanly instead of rendering "≈ 0.00 ". Zero / negative totals still
// render (a negative Nord Pool hour means the run was paid to consume, which
// the owner should see). Shares `APPROX_GLYPH` with the history-detail cost
// helpers so the same marker reads across surfaces.
export const formatEstimatedCostStatValue = (params: {
  plannedTotalCost: number;
  costUnit: string;
}): string | null => {
  const unit = params.costUnit.trim();
  if (unit.length === 0) return null;
  if (!Number.isFinite(params.plannedTotalCost)) return null;
  return `${APPROX_GLYPH} ${params.plannedTotalCost.toFixed(2)} ${unit}`;
};

// Labels for the smart-task detail hero's stat pairs. Kept beside their value
// formatters (`formatEnergyEstimateKWh` / `formatEstimatedCostStatValue`) in
// shared-domain rather than the settings-UI producer so runtime log
// breadcrumbs and the UI share one vocabulary (`feedback_ui_text_shared_with_logs`).
// `energy` pairs with the energy estimate (single figure or `expected…planned`
// range); `cost` pairs with the value-only estimated-cost figure. "Estimated
// cost" is spelled out — Rule 3 (`notes/ui-terminology.md`) bans abbreviations
// in visible labels; the two pairs sit on their own row under the subline, so
// the longer label wraps rather than truncates at 320 px.
export const SMART_TASK_HERO_STAT_LABELS = {
  energy: 'Needs',
  cost: 'Estimated cost',
} as const;

// Resolver for the "Delivered so far" hero subline. Branches by plan status:
//   - `cannot_meet`            → `Delivered X of Y kWh · still {curr} of {target}`
//   - on-track / at-risk / queued → `Delivered X of Y kWh · {start →} {curr} of {target}`
//
// The "start → current" arrow is rendered only when `startProgress` is known
// (caller resolves the back-calc from current − delivered × kWh-per-unit). When
// it's not, the line collapses to `now {curr} of {target}` so the user still
// sees current vs target without us inventing a starting value.
//
// `targetUnit` is `°C` / `%` and matches `DeadlineLabels.targetUnit`. This
// line takes no deadline: the cannot-meet branch dropped its `· won't reach
// by` tail because the chip ("Cannot finish") + meta line ("Not
// enough time for this target. …") already announce the verdict, and restating
// it as a third tail read as alarm spam in the 2026-05-16 live walk. The
// "still {curr} of {target}" stem (vs the on-track "now …") still tonally
// pairs with the alert chip without re-asserting the failure.
//
// Returns `null` when planned energy is non-finite / zero (no allocation yet,
// or revision predates the field) or when both delivered and progress data
// are absent — the line has nothing concrete to say so the view suppresses it
// rather than emit "Delivered 0 of 0 kWh".
export type DeadlineDeliveredSoFarStatus =
  | 'cannot_meet'
  | 'on_track_or_queued';

export const formatDeadlineDeliveredSoFarLine = (
  status: DeadlineDeliveredSoFarStatus,
  deliveredKWh: number,
  plannedTotalKWh: number,
  currentProgress: number,
  startProgress: number | null,
  targetValue: number,
  targetUnit: DeferredObjectiveUnit,
): string | null => {
  if (!Number.isFinite(plannedTotalKWh) || plannedTotalKWh <= 0) return null;
  if (!Number.isFinite(currentProgress) || !Number.isFinite(targetValue)) return null;
  // An energy task's progress IS the energy delivered, counted by the task
  // itself: one figure, stated once, against the task's own target.
  if (targetUnit === 'kWh') {
    return `Delivered ${currentProgress.toFixed(1)} of ${targetValue.toFixed(1)} kWh`;
  }
  const deliveredKWhSafe = Number.isFinite(deliveredKWh) && deliveredKWh > 0
    ? deliveredKWh : 0;
  const energyPart = `Delivered ${deliveredKWhSafe.toFixed(1)} of ${plannedTotalKWh.toFixed(1)} kWh`;
  const currentLabel = formatProgressValueForUnit(currentProgress, targetUnit);
  const targetLabel = formatProgressValueForUnit(targetValue, targetUnit);
  if (status === 'cannot_meet') {
    return `${energyPart} · still ${currentLabel} of ${targetLabel} target`;
  }
  // Compare formatted labels rather than raw numeric deltas: for percent
  // values (`Math.round`) two readings 0.4 percentage points apart still
  // render identically, and a "45% → 45%" arrow is meaningless to the user.
  // Falling through to "now X" keeps the line honest when the rounded
  // start-vs-current motion is invisible at display precision.
  const startLabel = startProgress !== null && Number.isFinite(startProgress)
    ? formatProgressValueForUnit(startProgress, targetUnit)
    : null;
  if (startLabel !== null && startLabel !== currentLabel) {
    return `${energyPart} · ${startLabel} → ${currentLabel} of ${targetLabel} target`;
  }
  return `${energyPart} · now ${currentLabel} of ${targetLabel} target`;
};
