import type { DeferredObjectiveActivePlanStatusV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type {
  DeadlineLabels,
  DeadlineLiveState,
} from '../../../shared-domain/src/deadlineLabels.ts';
import type { HorizonHour } from './deadlinePlanData.ts';
import {
  formatDeadlineFull,
  formatHourLabel,
  formatTarget,
} from './deadlinePlanFormatters.ts';
import type { DeadlinePlanHeroTone, DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

// For `%` clamp to ≥ 1 with `ceil` so a sub-1% shortfall does not render as
// "0%" while the warning chip says "Cannot finish" — that mismatch was
// flagged on the original PR (copilot review of `formatShortfallLabel`).
const formatShortfallLabel = (shortfallUnits: number, unit: '°C' | '%'): string => (
  unit === '°C' ? `${shortfallUnits.toFixed(1)} °C` : `${Math.max(1, Math.ceil(shortfallUnits))}%`
);

// Returns the chip label key; the caller looks up the kind-specific label
// from `DeadlineLabels.liveStateChipLabel`. Shared by the hero, smart-task
// list, and device card so the three surfaces never disagree.
export const resolveLiveState = (params: {
  isPlanReady: boolean;
  firstChargingHour: HorizonHour | undefined;
  nowMs: number;
}): DeadlineLiveState => {
  if (!params.isPlanReady) return 'building_plan';
  if (!params.firstChargingHour) return 'ok';
  if (params.firstChargingHour.startsAtMs <= params.nowMs) return 'active';
  return 'queued';
};

const resolveStateChipTone = (
  liveState: DeadlineLiveState,
): DeadlinePlanPayload['hero']['chips'][number]['tone'] => {
  if (liveState === 'active') return 'ok';
  if (liveState === 'paused_unplugged') return 'warn';
  return 'info';
};

// Canonical chip order `[kind, ?state, ?cannotMeet, ?confidence]` — kind
// identity reads first across every Smart-task surface. The live-state chip
// is suppressed when the plan `cannotMeet`s: the resolver returns `'ok'`
// whenever there are no scheduled hours, so without this gate we would render
// "On track" or "Active now" alongside "Cannot finish" — a contradiction at
// the moment we most need the user to trust PELS. The cannot-meet chip tone
// is supplied by the caller so it stays in sync with the hero rim tone:
// `alert` (red) for `cannot_meet`, `warn` (amber) for `at_risk`.
export const buildHeroChips = (params: {
  labels: DeadlineLabels;
  liveState: DeadlineLiveState;
  cannotMeet: boolean;
  cannotMeetChipTone: 'alert' | 'warn';
  confidence: string | null;
}): DeadlinePlanPayload['hero']['chips'] => [
  { text: params.labels.kindChipLabel, tone: 'info' },
  ...(params.cannotMeet
    ? []
    : [{
      text: params.labels.liveStateChipLabel[params.liveState],
      tone: resolveStateChipTone(params.liveState),
    }]),
  ...(params.cannotMeet
    ? [{ text: params.labels.cannotMeetChipLabel, tone: params.cannotMeetChipTone }]
    : []),
  ...(params.confidence ? [{ text: `Confidence ${params.confidence}`, tone: 'muted' as const }] : []),
];

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

// Walks budget → shortfall → unknown-reason so we never render the warning
// chip without a paired body reason.
export const resolveCannotMeetMeta = (params: {
  labels: DeadlineLabels;
  shortfallUnits: number;
  shortfallUnit: '°C' | '%';
  dailyBudgetExhausted: boolean;
}): string => {
  if (params.dailyBudgetExhausted) return params.labels.cannotMeetDailyBudgetExhausted;
  if (params.shortfallUnits > 0) {
    return params.labels.cannotMeetShortfall(formatShortfallLabel(params.shortfallUnits, params.shortfallUnit));
  }
  return params.labels.cannotMeetUnknownReason;
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
  shortfallUnits: number;
  shortfallUnit: '°C' | '%';
  dailyBudgetExhausted: boolean;
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
  const liveState = resolveLiveState({
    isPlanReady: true,
    firstChargingHour: params.firstChargingHour,
    nowMs: params.nowMs,
  });
  const speedModeLabel = resolveSpeedModeLabel(params.kwhPerUnitSource);
  // When the chip says "Cannot finish" we must not fall back to the on-track
  // meta copy — that contradicts the chip. The dedicated resolver guarantees a
  // reasoned body line in every cannot-meet branch.
  const metaLine = params.cannotMeet
    ? resolveCannotMeetMeta(params)
    : formatMetaLine({
      energyNeededKWh: params.energyNeededKWh,
      hoursLeft: params.hoursLeft,
      planningSpeedKw: params.planningSpeedKw,
      estimatedDurationText: params.estimatedDurationText,
      speedModeLabel,
    });
  // The cannot-meet chip mirrors the hero rim: `alert` (red) for `cannot_meet`
  // and `warn` (amber) for `at_risk`. Anything else means `cannotMeet` is false
  // and the chip isn't rendered, so the fallback never reaches the UI; it
  // exists only so the union narrows for the `chip.tone` type.
  const cannotMeetChipTone: 'alert' | 'warn' = params.tone === 'alert' ? 'alert' : 'warn';
  return {
    chips: buildHeroChips({
      labels: params.labels,
      liveState,
      cannotMeet: params.cannotMeet,
      cannotMeetChipTone,
      confidence: params.confidence,
    }),
    tone: params.tone,
    sectionLabel: `${params.labels.kindChipLabel} plan`,
    headline,
    subline,
    metaLine,
  };
};
