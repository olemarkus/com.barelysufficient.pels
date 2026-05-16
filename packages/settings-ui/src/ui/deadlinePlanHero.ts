import type { DeferredObjectiveActivePlanStatusV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type {
  DeadlineCannotMeetRecourse,
  DeadlineLabels,
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
// useful signal; the caller passes action-oriented text ("Estimating" /
// "Refining") for low / medium confidence.
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

export const resolveHeroHeadline = (params: {
  labels: DeadlineLabels;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
  cannotMeet: boolean;
}): string => {
  if (params.cannotMeet) return params.labels.cannotMeetChipLabel;
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
      confidenceChipText: resolveConfidenceChipText(params.confidence),
    }),
    tone: params.tone,
    sectionLabel: params.labels.sectionLabel,
    headline,
    headlineReason: resolveQueuedHeadlineReason(params),
    subline,
    metaLine,
    recourse: resolveCannotMeetRecourse(params),
  };
};
