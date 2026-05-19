import type { DeferredObjectiveActivePlanStatusV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import {
  formatDeadlineCostMetaLine,
  formatDeadlineDeliveredSoFarLine,
  type DeadlineCannotMeetRecourse,
  type DeadlineLabels,
} from '../../../shared-domain/src/deadlineLabels.ts';
import type { HorizonHour } from './deadlinePlanData.ts';
import {
  formatDeadlineFull,
  formatHourLabel,
  formatTarget,
} from './deadlinePlanFormatters.ts';
import type { DeadlinePlanHeroTone, DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

// Canonical chip order `[kind, ?cannotMeet, ?confidence]` — kind identity
// reads first across every Smart-task surface. The live-state chip is no
// longer rendered on the active hero: the headline already says
// "Heating from HH:MM" / "Charging from HH:MM" / "On track …" / "Cannot
// finish", so the chip duplicated information instead of adding signal. The
// pending hero still emits its own state chip (Building plan… / Paused —
// unplugged) via `deadlinePlan.ts:buildPendingHero`, where the state is the
// only available signal. The cannot-meet chip tone is supplied by the caller
// so it stays in sync with the hero rim tone: `alert` (red) for
// `cannot_meet`, `warn` (amber) for `at_risk`. The confidence chip is
// suppressed when `confidence === 'high'` because the common case carries no
// useful signal; it is also suppressed for true `cannot_meet` heroes because
// the Cannot-finish chip and body reason own that row. The caller passes
// action-oriented text ("Estimating" / "Refining") for low / medium
// confidence when it remains useful.
export const buildHeroChips = (params: {
  labels: DeadlineLabels;
  cannotMeet: boolean;
  cannotMeetChipTone: 'alert' | 'warn';
  confidenceChipText: string | null;
}): DeadlinePlanPayload['hero']['chips'] => [
  { text: params.labels.kindChipLabel, tone: 'info' },
  ...(params.cannotMeet
    ? [{ text: params.labels.cannotMeetChipLabel, tone: params.cannotMeetChipTone }]
    : []),
  ...(params.confidenceChipText !== null
    ? [{ text: params.confidenceChipText, tone: 'muted' as const }]
    : []),
];

// Live-confidence chip: `high` carries no signal worth a chip — suppress.
// `low` and `medium` map to action-oriented words so the user reads the chip
// as PELS's current learning state rather than a bare quality score.
export const resolveConfidenceChipText = (confidence: string | null): string | null => {
  if (confidence === 'low') return 'Estimating';
  if (confidence === 'medium') return 'Refining';
  return null;
};

export const resolveLiveHeroConfidenceChipText = (params: {
  confidence: string | null;
  planStatus: DeferredObjectiveActivePlanStatusV1;
}): string | null => {
  if (params.planStatus === 'cannot_meet') return null;
  return resolveConfidenceChipText(params.confidence);
};

// Maps the planner's `planStatus` to the hero's CSS rim tone. Resolved at the
// producer so the view layer never branches on planner internals.
//   `cannot_meet` → `alert`  (red rim — physically can't deliver)
//   `at_risk`     → `warn`   (amber rim — currently behind, but recoverable)
//   `on_track`    → `good`   (green rim — healthy)
//   `satisfied`   → `good`   (green rim — already at/past target)
//   `invalid`     → `info`   (neutral — planner couldn't produce a valid plan
//                             and the hero will show the pending/empty copy)
export const resolveHeroTone = (
  planStatus: DeferredObjectiveActivePlanStatusV1,
): DeadlinePlanHeroTone => {
  if (planStatus === 'cannot_meet') return 'alert';
  if (planStatus === 'at_risk') return 'warn';
  if (planStatus === 'invalid') return 'info';
  return 'good';
};

// Returns the live hero's headline string. Producer suppresses the cannot-meet
// headline (returns `null`) because the cannot-finish chip already says the
// same words and the body postmortem expands on the cause — repeating
// "Cannot finish" at headline height (per `TODO 1569` / lived-walk
// 2026-05-16) read as alarm spam rather than information. The chip + body
// pair carries the entire signal; the headline collapses on this branch so
// the section flows chip → subline → meta line directly.
export const resolveHeroHeadline = (params: {
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
  cannotMeet: boolean;
}): string | null => {
  if (params.cannotMeet) return null;
  if (!params.firstChargingHour) return 'On track — no action needed yet';
  if (params.firstChargingHour.startsAtMs <= params.nowMs) {
    return `${params.labels.activeChipLabel} now`;
  }
  return `${params.labels.activeChipLabel} from ${formatHourLabel(params.firstChargingHour.startsAtMs)}`;
};

// Resolves the "why does the smart task start at HH:MM" subline below the
// queued headline. Returns null when the hero is not in the queued state
// (`firstChargingHour <= nowMs` or no charging hour at all), or when the
// resolver inside `labels` returns null — the view suppresses the line
// rather than fabricating a reason.
export const resolveQueuedHeadlineReason = (params: {
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
  cannotMeet: boolean;
  deadlineAtMs: number;
  computedFromPricesUpTo: number | null;
  // Counts buckets in the run-up whose per-bucket cap collapsed to zero
  // because the daily budget cap was hit. Distinct from `dailyBudgetExhausted`
  // (which gates the cannot-meet body copy and is restricted to
  // `planStatus === 'cannot_meet'`): the queued headline-reason resolver wants
  // to surface "Today's budget is full" on healthy on-track plans whose first
  // hour falls after midnight too.
  dailyBudgetExhaustedInRunUp: boolean;
}): string | null => {
  if (params.cannotMeet) return null;
  if (!params.firstChargingHour) return null;
  if (params.firstChargingHour.startsAtMs <= params.nowMs) return null;
  return params.labels.resolveQueuedHeadlineReason({
    firstPlannedTime: formatHourLabel(params.firstChargingHour.startsAtMs),
    pricesShortOfDeadline: params.computedFromPricesUpTo === null
      || params.computedFromPricesUpTo < params.deadlineAtMs,
    deadlineTime: formatHourLabel(params.deadlineAtMs),
    dailyBudgetExhausted: params.dailyBudgetExhaustedInRunUp,
  });
};

// Walks budget → shortfall → unknown-reason so we never render the warning
// chip without a paired body reason. Returns the user-visible cannot-meet
// sentence; `formatMetaLine` is then appended by `buildHero` so the rich
// "Needs X kWh · Y hours left · …" context coexists with the reason.
export const resolveCannotMeetMeta = (params: {
  labels: DeadlineLabels;
  shortfallUnits: number;
  dailyBudgetExhausted: boolean;
}): string => {
  if (params.dailyBudgetExhausted) return params.labels.cannotMeetDailyBudgetExhausted;
  if (params.shortfallUnits > 0) return params.labels.cannotMeetShortfall();
  return params.labels.cannotMeetUnknownReason;
};

// Resolves the recourse action surfaced below the cannot-finish body. Returns
// null when the plan is not cannot-meet so the view never branches on
// `cannotMeet` state. `open_budget` is reserved for the daily-budget cause;
// every other cannot-meet branch points at the device (`open_overview`).
//
// Per `feedback_hard_cap_is_physical.md`, no recourse branch suggests raising
// the capacity hard cap — `open_budget` lands on the daily-budget surface
// where users can lower the daily cap.
export const resolveCannotMeetRecourse = (params: {
  labels: DeadlineLabels;
  cannotMeet: boolean;
  dailyBudgetExhausted: boolean;
}): DeadlineCannotMeetRecourse | null => {
  if (!params.cannotMeet) return null;
  if (params.dailyBudgetExhausted) return params.labels.cannotMeetRecourse.openBudget;
  return params.labels.cannotMeetRecourse.openOverview;
};

// Falls back to the "Needs X kWh · N hours left" form when planning speed or
// estimated duration aren't carried on the latest revision (legacy persisted
// plans, devices missing calibration).
const formatMetaLine = (params: {
  energyNeededKWh: number;
  hoursLeft: number;
  planningSpeedKw: number | null;
  estimatedDurationText: string | null;
  speedModeLabel: string;
}): string => {
  const energy = `${params.energyNeededKWh.toFixed(1)} kWh`;
  if (params.planningSpeedKw !== null && params.estimatedDurationText !== null) {
    const speed = `${params.planningSpeedKw.toFixed(1)} kW`;
    return `Needs ${energy} · ${speed} · ${params.estimatedDurationText} · ${params.speedModeLabel}`;
  }
  const hourWord = params.hoursLeft === 1 ? 'hour' : 'hours';
  return `Needs ${energy} · ${params.hoursLeft} ${hourWord} left · ${params.speedModeLabel}`;
};

// `Manual` / `Conservative` are future modes (per the speed-mode design
// note) and would route through this same resolver if/when they ship.
const resolveSpeedModeLabel = (
  kwhPerUnitSource: 'learned' | 'bootstrap' | undefined,
): string => (kwhPerUnitSource === 'bootstrap' ? 'Learning…' : 'Auto');

export type BuildHeroInput = {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  deadlineAtMs: number;
  energyNeededKWh: number;
  hoursLeft: number;
  confidence: string | null;
  planStatus: DeferredObjectiveActivePlanStatusV1;
  nowMs: number;
  cannotMeet: boolean;
  // Remaining shortfall against the target after the planner's best-effort
  // allocation, in progress units (°C / %). Used to disambiguate the
  // "device-side shortfall" branch (`> 0`) from the "no clear cause"
  // fallback so the unknown-reason copy fires only when we actually have no
  // signal. The unit is no longer surfaced in user copy — see
  // `cannotMeetShortfall` for the rephrasing rationale.
  shortfallUnits: number;
  dailyBudgetExhausted: boolean;
  // Whether the latest revision's `dailyBudgetExhaustedBucketCount` is > 0.
  // Distinct from `dailyBudgetExhausted` above (which is gated on
  // `planStatus === 'cannot_meet'`): the queued headline-reason resolver
  // wants this signal even on healthy on-track plans whose first hour falls
  // after midnight.
  dailyBudgetExhaustedInRunUp: boolean;
  // Planner's `computedFromPricesUpTo` carried verbatim so the producer can
  // resolve the "prices not through deadline yet" headline-reason branch.
  // Null when the latest revision predates the field.
  computedFromPricesUpTo: number | null;
  planningSpeedKw: number | null;
  estimatedDurationText: string | null;
  kwhPerUnitSource: 'learned' | 'bootstrap' | undefined;
  // Producer-resolved CSS rim tone, derived from the latest revision's
  // `planStatus`. Carried through the payload so the view layer never branches
  // on planner internals.
  tone: DeadlinePlanHeroTone;
  // Σ (display-scaled price × deviceKwh) across the timeline's planned hours,
  // in the user's display currency (e.g. kr). Producer sums each render cycle
  // so the live cost reflects the latest revision. Zero / non-finite values
  // suppress the cost line at the shared-domain formatter.
  plannedTotalCost: number;
  // Σ priceValue × actualDeviceKwh for hours where `actualDeviceKwh` is known
  // (delivery so far in this run). Null when no run is active yet or no
  // delivery has been observed — the formatter collapses to the planned-only
  // form instead of fabricating a "0.00 kr so far" value.
  deliveredCostSoFar: number | null;
  // Cost-unit suffix (e.g. `kr`). Empty / null suppresses the cost line at
  // the shared-domain formatter — Flow / Homey schemes without a unit don't
  // get a misleading Norwegian-specific label.
  costUnit: string;
  // Σ actualDeviceKwh across the run (kWh delivered so far). Zero when the
  // run hasn't started consuming yet — the formatter renders `0.0 of Y kWh`
  // so the user sees the planned total even before delivery.
  deliveredKWh: number;
  // Total energy the planner currently estimates the run needs to reach the
  // target (`latest.energyNeededKWh`). Drives the "of Y kWh" tail. Note: this
  // is the latest revision's value, not original — `rate_refined` / replans
  // can shift it as the planner observes the device.
  plannedTotalKWh: number;
  // Current device reading on the objective unit (°C / %). Null when the
  // device hasn't reported yet — the delivered-so-far line suppresses.
  currentProgress: number | null;
  // Back-calculated start-of-run progress when the kWh-per-unit rate is
  // known: `current − delivered × kWhPerUnit`. Null otherwise — the line
  // collapses to `now …` rather than inventing a starting value.
  startProgress: number | null;
  targetValue: number | null;
  targetUnit: '°C' | '%';
};

// Resolves the "Delivered X of Y kWh · …" subline. Returns null when there's
// no plan to summarise (planned kWh zero / non-finite, no progress reading,
// or no live target). The two visible branches — on-track-ish vs cannot-meet
// — collapse the planner's status union (cannot_meet / at_risk / on_track /
// satisfied / queued) to the two phrasing shapes per the task design.
export const resolveDeliveredSoFarLine = (
  params: Pick<
    BuildHeroInput,
    'cannotMeet'
    | 'tone'
    | 'deliveredKWh'
    | 'plannedTotalKWh'
    | 'currentProgress'
    | 'startProgress'
    | 'targetValue'
    | 'targetUnit'
    | 'deadlineAtMs'
  >,
): string | null => {
  if (params.currentProgress === null || params.targetValue === null) return null;
  // `cannotMeet === true` on the BuildHeroInput collapses both `cannot_meet`
  // and `at_risk` together (so the chip surface stays in sync). For the
  // delivered-so-far line we want the "won't reach" copy *only* on the
  // physically-can't-deliver case — `tone === 'alert'` is the producer's
  // already-resolved signal for that, derived from `planStatus`. At-risk
  // (`tone === 'warn'`) keeps the on-track-shaped phrasing so the line stays
  // hopeful while the chip still warns.
  const isWontReach = params.cannotMeet && params.tone === 'alert';
  return formatDeadlineDeliveredSoFarLine({
    status: isWontReach ? 'cannot_meet' : 'on_track_or_queued',
    deliveredKWh: params.deliveredKWh,
    plannedTotalKWh: params.plannedTotalKWh,
    currentProgress: params.currentProgress,
    startProgress: params.startProgress,
    targetValue: params.targetValue,
    targetUnit: params.targetUnit,
    deadlineTime: formatHourLabel(params.deadlineAtMs),
  });
};

export const buildHero = (params: BuildHeroInput): DeadlinePlanPayload['hero'] => {
  const headline = resolveHeroHeadline(params);
  const target = formatTarget(params.objective);
  const deadline = formatDeadlineFull(params.deadlineAtMs);
  const subline = `${params.device.name} • Target ${target} by ${deadline}`;
  const speedModeLabel = resolveSpeedModeLabel(params.kwhPerUnitSource);
  const baseMetaLine = formatMetaLine({
    energyNeededKWh: params.energyNeededKWh,
    hoursLeft: params.hoursLeft,
    planningSpeedKw: params.planningSpeedKw,
    estimatedDurationText: params.estimatedDurationText,
    speedModeLabel,
  });
  // When the chip says "Cannot finish" we must not fall back to the on-track
  // meta copy alone — that loses the answer to "how bad is this?" (e.g.
  // "29.6 °C short" is meaningless without "needs 17 kWh, 8 hours left").
  // Compose the reasoned cannot-meet sentence with the `Needs N kWh · …`
  // context so both signals coexist on a single line.
  const metaLine = params.cannotMeet
    ? `${resolveCannotMeetMeta(params)} ${baseMetaLine}`
    : baseMetaLine;
  // The cannot-meet chip mirrors the hero rim: `alert` (red) for `cannot_meet`
  // and `warn` (amber) for `at_risk`. Anything else means `cannotMeet` is false
  // and the chip isn't rendered, so the fallback never reaches the UI; it
  // exists only so the union narrows for the `chip.tone` type.
  const cannotMeetChipTone: 'alert' | 'warn' = params.tone === 'alert' ? 'alert' : 'warn';
  return {
    chips: buildHeroChips({
      labels: params.labels,
      cannotMeet: params.cannotMeet,
      cannotMeetChipTone,
      confidenceChipText: resolveLiveHeroConfidenceChipText({
        confidence: params.confidence,
        planStatus: params.planStatus,
      }),
    }),
    tone: params.tone,
    sectionLabel: params.labels.sectionLabel,
    headline,
    headlineReason: resolveQueuedHeadlineReason(params),
    subline,
    metaLine,
    costMetaLine: formatDeadlineCostMetaLine({
      plannedTotalCost: params.plannedTotalCost,
      deliveredCost: params.deliveredCostSoFar,
      costUnit: params.costUnit,
    }),
    deliveredSoFarLine: resolveDeliveredSoFarLine(params),
    recourse: resolveCannotMeetRecourse(params),
  };
};
