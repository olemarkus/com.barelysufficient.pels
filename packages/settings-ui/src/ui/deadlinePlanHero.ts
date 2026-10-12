import type { DeferredObjectiveActivePlanStatusV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { ObjectiveProfileConfidence } from '../../../contracts/src/objectiveProfileTypes.ts';
import {
  formatConfidenceChipLabel,
  formatDeadlineDeliveredSoFarLine,
  formatSmartTaskCarLimitReason,
  formatEnergyEstimateKWh,
  formatEstimatedCostStatValue,
  SMART_TASK_HERO_STAT_LABELS,
  resolveReportedCarChargeLimit,
  resolveSmartTaskAtRiskWhy,
  resolveSmartTaskBudgetRole,
  resolveSmartTaskLiveCause,
  type DeadlineCannotMeetRecourse,
  type DeadlineBudgetRole,
  type DeadlineLabels,
  type SmartTaskCarChargeLimit,
  type SmartTaskLiveCause,
} from '../../../shared-domain/src/deadlineLabels.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import {
  ONE_HOUR_MS,
  type DeadlinePlanSchedule,
  type HorizonHour,
  type ObjectivePayloadReady,
} from './deadlinePlanData.ts';
import { resolveActualDeviceKwh } from './deadlinePlanTimeline.ts';
import {
  formatDeadlineFull,
  formatHourLabel,
  formatTarget,
} from './deadlinePlanFormatters.ts';
import type { DeadlineHeroStat, DeadlinePlanHeroTone, DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

export type DeadlineHeroStatusChip = { text: string; tone: 'alert' | 'warn' };

export const resolveHeroStatusChip = (params: {
  labels: DeadlineLabels;
  planStatus: DeferredObjectiveActivePlanStatusV1;
}): DeadlineHeroStatusChip | null => {
  if (params.planStatus === 'cannot_meet') {
    return { text: params.labels.cannotMeetChipLabel, tone: 'alert' };
  }
  if (params.planStatus === 'at_risk') {
    return { text: params.labels.atRiskChipLabel, tone: 'warn' };
  }
  return null;
};

// Canonical chip order `[kind, ?status, ?confidence]` — kind identity reads
// first across every Smart-task surface. Most live states stay in the headline:
// "Heating from HH:MM" / "Charging from HH:MM" / "On track …". Pending heroes
// still emit their own state chip (Building plan… / Paused — unplugged) via
// `deadlinePlan.ts:buildPendingHero`, where the state is the only available
// signal. The active hero keeps only the risk/failure status chip (`At risk` /
// `Cannot finish`) so the warning row matches the list. The confidence chip is
// suppressed when `confidence === 'high'` because the common case carries no
// useful signal; it is also suppressed for true `cannot_meet` heroes because
// the Cannot-finish chip and body reason own that row. The caller passes
// action-oriented text ("Estimating" / "Refining") for low / medium confidence
// when it remains useful.
export const buildHeroChips = (
  labels: DeadlineLabels,
  statusChip: DeadlineHeroStatusChip | null,
  confidenceChipText: string | null,
): DeadlinePlanPayload['hero']['chips'] => [
  { text: labels.kindChipLabel, tone: 'info' },
  ...(statusChip ? [statusChip] : []),
  ...(confidenceChipText !== null ? [{ text: confidenceChipText, tone: 'muted' as const }] : []),
];

// Live-confidence chip: delegate the vocabulary to shared-domain so the hero
// and Smart-task list cannot drift.
export const resolveConfidenceChipText = (
  confidence: ObjectiveProfileConfidence | null | undefined,
): string | null => formatConfidenceChipLabel(confidence);

// Shown only during genuine cold-start (`learning`) and never on a settled
// task: `on_track` is silent (a learned-but-forever-`low` thermal rate would
// nag), and `cannot_meet` already owns its row. Mirrors the Smart-tasks list
// gate in `formatSmartTaskListConfidenceChipLabel`.
export const resolveLiveHeroConfidenceChipText = (
  confidence: ObjectiveProfileConfidence | null,
  planStatus: DeferredObjectiveActivePlanStatusV1,
  learning: boolean,
): string | null => {
  if (planStatus === 'cannot_meet' || planStatus === 'on_track') return null;
  if (!learning) return null;
  return resolveConfidenceChipText(confidence);
};

// Maps the planner's `planStatus` to the hero's CSS rim tone. Resolved at the
// producer so the view layer never branches on planner internals.
//   `cannot_meet` → `alert`  (red rim — physically can't deliver)
//   `at_risk`     → `warn`   (amber rim — currently behind, but recoverable)
//   `on_track`    → `good`   (green rim — healthy)
//   `satisfied`   → `good`   (green rim — already at/past target)
//   `invalid`     → `info`   (neutral — planner couldn't produce a valid plan
//                             and the hero will show the pending/empty copy)
//
// Distinct from `usageHero.ts:resolveHeroTone` (pace-based, ok/warn/alert) —
// kept under a separate symbol so a global rename or IDE auto-import can't
// pick the wrong helper.
export const resolveDeadlineHeroTone = (
  planStatus: DeferredObjectiveActivePlanStatusV1,
): DeadlinePlanHeroTone => {
  if (planStatus === 'cannot_meet') return 'alert';
  if (planStatus === 'at_risk') return 'warn';
  if (planStatus === 'invalid') return 'info';
  return 'good';
};

// Returns the live hero's headline string. Producer suppresses the headline
// (returns `null`) only on true cannot-finish heroes (`tone === 'alert'`)
// because the cannot-finish chip already says the same words and the body
// postmortem expands on the cause — repeating "Cannot finish" at headline
// height (per the 2026-05-16 lived walk) read as alarm spam rather
// than information. The chip + body pair carries the entire signal on that
// branch so the section flows chip → subline → meta line directly. At-risk
// heroes (`tone === 'warn'`) keep their live-state headline ("Heating from
// HH:MM" / "Charging from HH:MM") per `notes/ui-terminology.md` *when a
// scheduled hour exists*: the At-risk chip warns, but the headline still
// answers "what is the device doing right now?". The `feasible_above_floor`
// at-risk plan has no floor-planned hour, so there is nothing live to
// announce — its headline is suppressed like `alert`, leaving the chip +
// meta line to carry the warning rather than a contradictory "On track".
//
// On an at-risk hero a live cause (a confirmed device-side stop, the car's own
// limit or schedule) also suppresses it: "Charging now" from
// the booked hour would contradict the reason line saying the device is not
// taking power. A satisfied or healthy hero carrying a stale cause keeps it.
export const resolveHeroHeadline = (
  labels: DeadlineLabels,
  firstChargingHour: HorizonHour | undefined,
  nowMs: number,
  tone: DeadlinePlanHeroTone,
  liveCause: SmartTaskLiveCause | null,
): string | null => {
  // `warn` is the at-risk tone: a live cause explains that status, so the booked
  // hour's live state would contradict it. A satisfied or healthy hero keeps it.
  if (tone === 'alert' || (tone === 'warn' && liveCause !== null)) return null;
  if (!firstChargingHour) {
    // Only a genuinely on-track plan (`good`) earns the reassuring sentinel;
    // an at-risk (`warn`) plan with no scheduled hour stays headless so it
    // can't claim "On track" while the chip + meta line warn otherwise.
    return tone === 'good' ? 'On track — no action needed yet' : null;
  }
  if (firstChargingHour.startsAtMs <= nowMs) {
    return `${labels.activeChipLabel} now`;
  }
  return `${labels.activeChipLabel} from ${formatHourLabel(firstChargingHour.startsAtMs)}`;
};

// Resolves the "why does the smart task start at HH:MM" subline below the
// queued headline. Returns null when the hero is not in the queued state
// (`firstChargingHour <= nowMs` or no charging hour at all), or when the
// resolver inside `labels` returns null — the view suppresses the line
// rather than fabricating a reason.
//
// `computedFromPricesUpTo` is the latest revision's, carried verbatim so the
// "prices not through deadline yet" branch needs no view-side comparison.
// `plannedWindowCheaperThanNow` is the producer-verified "planned hours average
// price < current hour price" comparison (`resolvePlannedWindowCheaperThanNow`
// below); it gates the "Cheaper than now" sentence so it never contradicts the
// schedule chart's bars.
export const resolveQueuedHeadlineReason = (
  labels: DeadlineLabels,
  firstChargingHour: HorizonHour | undefined,
  nowMs: number,
  cannotMeet: boolean,
  deadlineAtMs: number,
  computedFromPricesUpTo: number | null,
  plannedWindowCheaperThanNow: boolean,
): string | null => {
  if (cannotMeet) return null;
  if (!firstChargingHour) return null;
  if (firstChargingHour.startsAtMs <= nowMs) return null;
  return labels.resolveQueuedHeadlineReason({
    firstPlannedTime: formatHourLabel(firstChargingHour.startsAtMs),
    pricesShortOfDeadline: computedFromPricesUpTo === null || computedFromPricesUpTo < deadlineAtMs,
    deadlineTime: formatHourLabel(deadlineAtMs),
    plannedWindowCheaperThanNow,
  });
};

// Resolves the user-visible cannot-meet reason sentence rendered as the hero's
// `metaLine`. The magnitude context ("Needs X kWh", estimated cost) now lives
// in the hero stat pairs (Needs / Estimated cost), so this line carries ONLY
// the cannot-finish diagnosis — no appended "Needs … · hours left" tail. Only
// ever called on a `cannot_meet` plan (see `buildHero`), so the target
// genuinely won't be reached — the budget-exhausted cause gets its own copy
// and everything else falls through to the blameless "may not reach the
// target" shortfall sentence. We do not re-derive a UI-side shortfall to gate
// this: that recomputation (inverse of the low-confidence learned rate)
// disagreed with the planner's verdict and produced a "can't determine why"
// dead-end on plans the planner had already classified as cannot-meet.
export const resolveCannotMeetMeta = (
  labels: DeadlineLabels,
  planStatus: DeferredObjectiveActivePlanStatusV1,
  budgetRole: DeadlineBudgetRole,
  liveCause: SmartTaskLiveCause | null,
): string => {
  // A live cause (a confirmed device-side stop, the car's own charge limit)
  // outranks both cost causes: neither the target nor the
  // deadline is what needs changing. From the same shared resolver the Smart
  // tasks widget uses, so the surfaces cannot diverge.
  if (liveCause !== null) return liveCause.reason;
  // A time-only at-risk task is hedged: it can still land, so "Not enough time …
  // Lower the target" would overstate it. The widget's at-risk line, word for
  // word. A budget cause keeps its own sentence below, which names the remedy.
  if (planStatus === 'at_risk' && budgetRole === 'none') {
    return resolveSmartTaskAtRiskWhy(budgetRole);
  }
  if (budgetRole === 'sole') return labels.cannotMeetDailyBudgetExhausted;
  // Named but not promised: lifting the budget would plan more energy and still
  // miss, so this says so rather than sending the owner to the Budget tab.
  if (budgetRole === 'contributing') return labels.cannotMeetDailyBudgetContributed;
  return labels.cannotMeetShortfall();
};

// The reason line for a task whose car's own charge limit sits below its target; null otherwise.
const resolveCarLimitMeta = (carChargeLimit: SmartTaskCarChargeLimit | null): string | null => (
  carChargeLimit === null ? null : formatSmartTaskCarLimitReason(carChargeLimit)
);

// Whether the hero reports a task that may not finish: the reason line, the
// recourse and the queued subline all key off this.
const isCannotMeetStatus = (planStatus: DeferredObjectiveActivePlanStatusV1): boolean => (
  planStatus === 'cannot_meet' || planStatus === 'at_risk'
);

// Resolves the recourse action surfaced below the cannot-finish body. Returns
// null when the plan is not cannot-meet so the view never branches on
// `cannotMeet` state. `open_budget` is reserved for the daily-budget cause;
// every other cannot-meet branch points at the device (`open_overview`).
//
// The device-side branch threads the active task's `deviceId` onto the payload
// so the click dispatcher (`deadlinePlanMount.ts`) opens the device-settings
// overlay after landing on Overview — one click instead of "land on Overview,
// hunt for the device card." Mirrors the history-detail "Review device"
// recourse pattern (`resolveMissedHistoryRecourse` in shared-domain). When
// `deviceId` is empty/missing the spread yields `deviceId: ''`; the
// dispatcher's `length > 0` guard then gracefully degrades to landing on
// Overview without dispatching `open-device-detail`.
//
// Per `feedback_hard_cap_is_physical.md`, no recourse branch suggests raising
// the capacity hard cap — `open_budget` lands on the daily-budget surface
// where users can lower the daily cap.
export const resolveCannotMeetRecourse = (
  labels: DeadlineLabels,
  planStatus: DeferredObjectiveActivePlanStatusV1,
  budgetRole: DeadlineBudgetRole,
  liveCause: SmartTaskLiveCause | null,
  deviceId: string,
): DeadlineCannotMeetRecourse | null => {
  if (!isCannotMeetStatus(planStatus)) return null;
  // No recourse for a live cause: the reason sentence already names the action
  // (turn the device on, check the device, raise the car's own limit), and
  // neither the budget surface nor PELS's device settings hold the fix.
  if (liveCause !== null) return null;
  // Only the sole case routes to the Budget tab.
  if (budgetRole === 'sole') return labels.cannotMeetRecourse.openBudget;
  // A time-only at-risk task has no device setting to fix: the widget offers
  // none either. The device button is for a task that cannot finish.
  if (planStatus === 'at_risk') return null;
  // The contributing case gets NO recourse, for the same reason a device the user
  // turned off gets none: the sentence already names the only action, and it is a
  // toggle in this very panel. The device overlay this would otherwise open holds
  // a different, similarly-named control (the standing per-device budget
  // exemption), so navigating there would point at the wrong lever.
  if (budgetRole === 'contributing') return null;
  return { ...labels.cannotMeetRecourse.openOverview, deviceId };
};

// Prorate one bucket's `actualKWh` against the plan's run interval. Tracker
// buckets accumulate incrementally during the current hour (see
// `lib/power/trackerEnergy.ts`), so the value represents `[hour_start,
// min(now, hour_end))` of measured energy — not necessarily a full-hour
// aggregate. The relevant slice for delivered-so-far is
// `[max(startedAtMs, hour_start), min(now, hour_end))`, so the bucket is
// prorated by `relevant / elapsed`: past closed hours have
// `elapsed = ONE_HOUR_MS`; the current open hour has `elapsed = now -
// hour_start` and the prorate becomes "fraction of the already-elapsed slice
// that landed after `startedAtMs`". Returns 0 for any bucket that doesn't
// overlap the run interval, or whose tracker reading is missing / non-positive.
const resolveProratedActualKWh = (input: ObjectivePayloadReady, hourStartsAtMs: number): number => {
  const { startedAtMs } = input.ctx.activePlan;
  const { nowMs } = input.ctx;
  const hourEndMs = hourStartsAtMs + ONE_HOUR_MS;
  if (hourEndMs <= startedAtMs) return 0;
  const bucketCloseMs = Math.min(nowMs, hourEndMs);
  const elapsedMs = bucketCloseMs - hourStartsAtMs;
  const relevantMs = bucketCloseMs - Math.max(startedAtMs, hourStartsAtMs);
  if (elapsedMs <= 0 || relevantMs <= 0) return 0;
  const actualKWh = resolveActualDeviceKwh(input.bootstrap, input.ctx.deviceId, hourStartsAtMs);
  if (actualKWh === null || actualKWh <= 0) return 0;
  return actualKWh * (relevantMs / elapsedMs);
};

// Resolves the live-derived cost + delivered-kWh fields of the hero.
//
// Live derivation (no persistence): the active plan revisions carry hourly
// planned kWh; the power tracker carries hourly actual kWh per device. We
// scale `hour.price` by the cost-display divisor (same scaling the timeline
// uses) so the cost reads in the user's display currency unit.
const resolveLiveCostAndDelivery = (
  input: ObjectivePayloadReady,
  currentChargeByStartMs: Map<number, number>,
): { plannedTotalCost: number; deliveredKWh: number } => {
  const divisor = Math.max(1, input.costDisplay.divisor);
  let plannedTotalCost = 0;
  let deliveredKWh = 0;
  for (const hour of input.hours) {
    const displayPrice = hour.price / divisor;
    const plannedKWh = currentChargeByStartMs.get(hour.startsAtMs) ?? 0;
    if (plannedKWh > 0) plannedTotalCost += displayPrice * plannedKWh;
    const proratedKWh = resolveProratedActualKWh(input, hour.startsAtMs);
    if (proratedKWh > 0) deliveredKWh += proratedKWh;
  }
  return { plannedTotalCost, deliveredKWh };
};

// Producer-side price comparison feeding the queued hero's "Cheaper than now"
// reason line: true iff the planned hours' average price is strictly below
// the current hour's price. Reads the same per-hour prices and planned-hour
// set `buildTimeline` / `resolveLiveCostAndDelivery` consume, so the sentence
// can never contradict the schedule chart rendered beneath it. False when the
// comparison can't be made (no planned hours, or no hour contains `nowMs`),
// in which case the resolver falls back to the non-comparative phrasing.
const resolvePlannedWindowCheaperThanNow = (
  hours: HorizonHour[],
  currentChargeByStartMs: Map<number, number>,
  nowMs: number,
): boolean => {
  // Compares on the PLANNING price (`budgetPrice ?? total`) so the "cheaper than
  // now" claim reconciles with the schedule chart the user sees below it (also
  // planning-priced) and with the hours the scheduler actually ranked. Equals
  // the import-price comparison for a non-prosumer. The divisor cancels out of
  // a relative comparison, so raw planning prices are compared directly.
  const plannedPrices = hours
    .filter((hour) => (currentChargeByStartMs.get(hour.startsAtMs) ?? 0) > 0)
    .map((hour) => hour.planningPrice);
  if (plannedPrices.length === 0) return false;
  const currentHour = hours.find((hour) => nowMs >= hour.startsAtMs && nowMs < hour.endMs);
  if (!currentHour) return false;
  const plannedAverage = plannedPrices.reduce((sum, price) => sum + price, 0) / plannedPrices.length;
  return plannedAverage < currentHour.planningPrice;
};

const resolveFiniteNumber = (value: number | null | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

// Resolves the "Delivered X of Y kWh · …" subline against the energy the
// planner currently estimates the run needs (`latest.energyNeededKWh`; replans
// can shift it as the planner observes the device). The two visible branches
// collapse the planner's status union to two phrasing shapes: the "still
// {curr} of {target}" stem *only* on the physically-can't-deliver case
// (`cannot_meet`), while at-risk keeps the on-track-shaped phrasing ("now …")
// so the line stays hopeful while the chip still warns. The cannot-meet branch
// no longer appends "won't reach by HH:MM" — the chip + meta line already
// announce the verdict; see `formatDeadlineDeliveredSoFarLine`.
const resolveDeliveredSoFarLine = (
  input: ObjectivePayloadReady,
  planStatus: DeferredObjectiveActivePlanStatusV1,
  deliveredKWh: number,
): string | null => {
  const { progress, energy } = input;
  return formatDeadlineDeliveredSoFarLine(
    planStatus === 'cannot_meet' ? 'cannot_meet' : 'on_track_or_queued',
    deliveredKWh,
    energy?.energyNeededKWh ?? 0,
    progress.currentValue,
    input.ctx.activePlan.startProgressValue ?? null,
    progress.targetValue,
    progress.unit,
  );
};

export const buildHero = (
  input: ObjectivePayloadReady,
  schedule: DeadlinePlanSchedule,
): DeadlinePlanPayload['hero'] => {
  const { ctx, energy } = input;
  const { activePlan, nowMs } = ctx;
  const { labels, planStatus, currentChargeByStartMs } = schedule;
  // The cannot-meet body copy + recourse fire on a budget-bound verdict. The
  // producer-resolved `latest.floorShortfallCause === 'budget'` is the only
  // signal — it covers the per-bucket background-squeeze case (prod Connected
  // 300) that the retired count-based heuristic missed. Per
  // `feedback_layering_resolution_in_producer` the consumer reads the flat
  // producer field and stops (`resolveSmartTaskBudgetRole`, the rule the list
  // and the widget share). Absence is NOT "unknown": the recorder suppresses
  // the `none` case for byte-stability, so an absent cause means the floor was
  // not short at all.
  // Three states, not a boolean: the budget can explain the shortfall outright
  // (`sole` — lifting the per-bucket cap closes the gap), have a hand in it
  // without closing it (`contributing`), or be uninvolved. The middle one used
  // to be invisible, so a plan whose every hour was budget-shaped read as purely
  // physical. It is resolved before the live cause, which an unreached car
  // limit only supplies when the budget is uninvolved.
  const budgetRole = resolveSmartTaskBudgetRole(activePlan.latest);
  // The car's own charge limit, when it sits below an EV task's target.
  // Explains, before the car gets there, why delivery will stop short.
  const carChargeLimit = resolveReportedCarChargeLimit(activePlan);
  // The same live cause the Smart tasks widget explains, from the same resolver
  // (a confirmed device-side stop, the car stopped at its own charge limit).
  // Drives the reason sentence and suppresses the recourse, so an at-risk hero
  // reached through the overlay never explains itself with the target, the
  // deadline, or the budget.
  const liveCause = resolveSmartTaskLiveCause(activePlan.diagnosticReasonCode, carChargeLimit, budgetRole);
  const cannotMeet = isCannotMeetStatus(planStatus);
  const tone = resolveDeadlineHeroTone(planStatus);
  const firstChargingHour = input.hours.find((hour) => currentChargeByStartMs.has(hour.startsAtMs));
  const costAndDelivery = resolveLiveCostAndDelivery(input, currentChargeByStartMs);
  const energyNeededKWh = energy?.energyNeededKWh ?? 0;
  const target = formatTarget(ctx.objective);
  const deadline = formatDeadlineFull(ctx.deadlineAtMs);
  const subline = `${formatDisplayDeviceName(ctx.device.name)} • Target ${target} by ${deadline}`;
  // Stat pairs carry the payoff numbers (energy + estimated cost) as loud
  // values, replacing the old grey `Needs … · N hours left · Auto` +
  // `Cost ≈ …` line pair. The energy figure keeps the `expected…planned`
  // range while a buffer is booked (`formatEnergyEstimateKWh`) — that range is
  // the "still learning / provisional" signal, so no speed-mode badge is
  // needed. Labels come from shared-domain so log breadcrumbs match the UI.
  const stats: DeadlineHeroStat[] = [
    {
      label: SMART_TASK_HERO_STAT_LABELS.energy,
      value: formatEnergyEstimateKWh({
        energyPlannedKWh: energyNeededKWh,
        // Mean-based estimate paired with the buffered `energyNeededKWh`; the
        // range collapses when no buffer is booked.
        energyExpectedKWh: energy?.energyExpectedKWh ?? energyNeededKWh,
      }),
    },
  ];
  // Non-finite / no-unit values suppress the stat at the formatter: Flow /
  // Homey schemes without a unit don't get a misleading Norwegian-specific label.
  const estimatedCost = formatEstimatedCostStatValue({
    plannedTotalCost: costAndDelivery.plannedTotalCost,
    costUnit: input.costDisplay.unit,
  });
  if (estimatedCost !== null) {
    stats.push({ label: SMART_TASK_HERO_STAT_LABELS.cost, value: estimatedCost });
  }
  // The reason line now carries ONLY the cannot-finish diagnosis ("Not enough
  // time for this target. …" / "Today's daily budget is fully booked. …") —
  // the "how bad is this?" context ("needs 17 kWh") lives in the stat pairs
  // above, so a running task no longer stacks a reason paragraph. Null on
  // healthy / queued heroes, except one whose car's own charge limit sits below
  // the target, which says why delivery will stop short. A car that has stopped
  // there makes the task at risk, and the live cause explains it.
  const metaLine = cannotMeet
    ? resolveCannotMeetMeta(labels, planStatus, budgetRole, liveCause)
    : resolveCarLimitMeta(carChargeLimit);
  // True only during genuine cold-start; gates the "Estimating" confidence chip.
  const confidenceChipText = resolveLiveHeroConfidenceChipText(
    energy?.confidence ?? null,
    planStatus,
    energy?.learning ?? false,
  );
  return {
    chips: buildHeroChips(labels, resolveHeroStatusChip({ labels, planStatus }), confidenceChipText),
    tone,
    headline: resolveHeroHeadline(labels, firstChargingHour, nowMs, tone, liveCause),
    headlineReason: resolveQueuedHeadlineReason(
      labels,
      firstChargingHour,
      nowMs,
      cannotMeet,
      ctx.deadlineAtMs,
      resolveFiniteNumber(activePlan.latest.computedFromPricesUpTo),
      // Resolved from the same hour set the timeline + cost sums consume.
      resolvePlannedWindowCheaperThanNow(input.hours, currentChargeByStartMs, nowMs),
    ),
    subline,
    stats,
    metaLine,
    deliveredSoFarLine: resolveDeliveredSoFarLine(input, planStatus, costAndDelivery.deliveredKWh),
    // Threads the active task's device id onto the device-side recourse so the
    // click dispatcher deep-links to the device-settings overlay rather than
    // dead-ending on the Overview tab (mirrors history-detail's "Review device").
    recourse: resolveCannotMeetRecourse(labels, planStatus, budgetRole, liveCause, ctx.deviceId),
  };
};
