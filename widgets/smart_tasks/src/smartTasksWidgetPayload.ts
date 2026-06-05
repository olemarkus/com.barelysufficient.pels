import type {
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanHistoryEntry } from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../../../packages/contracts/src/settingsUiApi';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { resolveActivePlanChartData } from '../../../packages/shared-domain/src/deferredActivePlanChartData';
import {
  formatPlanHistoryMissedReason,
  formatPlanHistoryProgressLine,
  formatPlanHistoryReachedAtLine,
  getPlanHistoryOutcomeLabel,
  getPlanHistoryOutcomeTone,
} from '../../../packages/shared-domain/src/deferredPlanHistory';
import {
  type DeferredPlanHistoryChartData,
  resolveHistoryDetailChartData,
} from '../../../packages/shared-domain/src/deferredPlanHistoryChartData';
import {
  formatSmartTaskListConfidenceChipLabel,
  RECOURSE_CANNOT_MEET_BUDGET,
  RECOURSE_CANNOT_MEET_DEVICE,
  resolveSmartTaskLearning,
  resolveSmartTaskListStatus,
  resolveSmartTaskWidgetDetailCopy,
  resolveSmartTaskWidgetEtaVerb,
  resolveSmartTaskWidgetTargetActionVerb,
  SMART_TASK_WIDGET_EMPTY_HINT,
  SMART_TASK_WIDGET_PLAN_META_LABEL_PREFIX,
  SMART_TASK_WIDGET_STATUS_LABELS,
  SMART_TASK_WIDGET_TARGET_NOUN,
  type SmartTaskListStatusId,
} from '../../../packages/shared-domain/src/deadlineLabels';
import { EMPTY_SUBTITLE_DEFAULT } from './smartTasksWidgetConstants';
import type {
  SmartTasksWidgetEmptyPayload,
  SmartTasksWidgetEndedRow,
  SmartTasksWidgetPayload,
  SmartTasksWidgetRow,
  SmartTasksWidgetTone,
} from './smartTasksWidgetTypes';

export const ROW_CAP = 3;
// Recently-ended tasks shown below the active rows. Capped so the 220 px panel
// stays scannable and the payload bounded; newest-finalized first.
export const ENDED_ROW_CAP = 5;
// A task counts as "recently ended" when it finalized within this window.
export const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;
// Re-exported from the browser-safe constants module so existing consumers
// and tests keep a stable import surface off the builder.
export { EMPTY_SUBTITLE_DEFAULT };

const STATUS_TIER: Record<SmartTaskListStatusId, number> = {
  cannot_meet: 0,
  at_risk: 1,
  paused_unplugged: 2,
  building_plan: 2,
  queued: 3,
  on_track: 3,
  satisfied: 99,
};

const STATUS_TONE: Record<SmartTaskListStatusId, SmartTasksWidgetTone> = {
  cannot_meet: 'danger',
  at_risk: 'warn',
  paused_unplugged: 'muted',
  building_plan: 'muted',
  queued: 'ok',
  on_track: 'ok',
  satisfied: 'ok',
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

// The widget only ever draws the `trajectory` shape; the producers' `legacy_kwh`
// fallback (a kWh bar chart for old history entries) has no widget renderer. Map
// it to null at the boundary so `row.chart` is non-null EXACTLY when there's a
// trajectory to draw — matching the field's "null when nothing chartable" doc
// and letting the renderer skip a legacy branch.
const toWidgetChart = (chart: DeferredPlanHistoryChartData): DeferredPlanHistoryChartData | null => (
  chart.mode === 'trajectory' ? chart : null
);

const resolveCurrentValue = (
  device: TargetDeviceSnapshot | undefined,
  kind: DeferredObjectiveActivePlanV1['objectiveKind'],
): number | null => {
  if (!device) return null;
  if (kind === 'temperature') {
    return isFiniteNumber(device.currentTemperature) ? device.currentTemperature : null;
  }
  const percent = device.stateOfCharge?.percent;
  return isFiniteNumber(percent) ? percent : null;
};

const resolveTargetValue = (plan: DeferredObjectiveActivePlanV1): number | null => {
  if (plan.objectiveKind === 'temperature') {
    return isFiniteNumber(plan.targetTemperatureC) ? plan.targetTemperatureC : null;
  }
  return isFiniteNumber(plan.targetPercent) ? plan.targetPercent : null;
};

const resolvePlannerEtaMs = (plan: DeferredObjectiveActivePlanV1): number | null => {
  const hours = plan.latest?.hours;
  if (!hours || hours.length === 0) return null;
  const last = hours[hours.length - 1];
  return isFiniteNumber(last.startsAtMs) ? last.startsAtMs + 60 * 60 * 1000 : null;
};

const formatLocalHHMMFallback = (date: Date): string => (
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
);

const formatLocalHHMM = (ms: number, timeZone: string | null): string => {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone ?? undefined,
    }).format(date);
  } catch {
    return formatLocalHHMMFallback(date);
  }
};

// Calendar-day index (days since the Unix epoch) for `ms` in the given
// timeZone. Resolving Y/M/D through Intl in the *same* zone the time half is
// formatted in keeps the day word ("Today"/"Tomorrow") consistent with the
// "HH:MM" — otherwise a host in one zone and a widget timeZone in another can
// disagree (e.g. 23:30Z shown as 01:30 Oslo but still labelled "Today").
// Using en-CA gives an ISO-like `YYYY-MM-DD`, and comparing calendar dates
// (not durations) is inherently DST-safe.
const calendarDayIndex = (ms: number, timeZone: string | null): number => {
  try {
    const ymd = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timeZone ?? undefined,
    }).format(new Date(ms));
    const [y, m, d] = ymd.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / (24 * 60 * 60 * 1000));
  } catch {
    const date = new Date(ms);
    return Math.round(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (24 * 60 * 60 * 1000),
    );
  }
};

// Calendar-day difference in the widget timeZone. Returns days(deadline) - days(now).
const localDayDiff = (deadlineMs: number, nowMs: number, timeZone: string | null): number => (
  calendarDayIndex(deadlineMs, timeZone) - calendarDayIndex(nowMs, timeZone)
);

// Long deadline label for the detail panel: "Today 16:00", "Tomorrow 07:00",
// "Sat 16:00" for the rest of this week, "16 May 16:00" past that.
const formatDeadlineLong = (
  ms: number,
  nowMs: number,
  timeZone: string | null,
): string => {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const timePart = formatLocalHHMM(ms, timeZone);
  const dayDiff = localDayDiff(ms, nowMs, timeZone);
  if (dayDiff === 0) return `Today ${timePart}`;
  if (dayDiff === 1) return `Tomorrow ${timePart}`;
  try {
    if (dayDiff >= -6 && dayDiff <= 6) {
      const weekday = new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        timeZone: timeZone ?? undefined,
      }).format(date);
      return `${weekday} ${timePart}`;
    }
    const dayMonth = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: timeZone ?? undefined,
    }).format(date);
    return `${dayMonth} ${timePart}`;
  } catch {
    return formatLocalHHMMFallback(date);
  }
};

const formatDurationFromHours = (hours: number): string => {
  if (!Number.isFinite(hours) || hours <= 0) return '';
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const formatKwh = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(1)} kWh`;
};

const resolveDurationPart = (revision: DeferredObjectiveActivePlanRevisionV1): string | null => {
  if (revision.estimatedDurationText) return `≈${revision.estimatedDurationText}`;
  const speed = revision.planningSpeedKw;
  if (speed && speed > 0 && revision.energyNeededKWh > 0) {
    const dur = formatDurationFromHours(revision.energyNeededKWh / speed);
    return dur ? `≈${dur}` : null;
  }
  return null;
};

const resolveSpeedPart = (revision: DeferredObjectiveActivePlanRevisionV1): string | null => {
  const speed = revision.planningSpeedKw;
  if (!speed || speed <= 0) return null;
  return `${(Math.round(speed * 10) / 10).toFixed(1)} kW`;
};

const resolveEnergyPart = (revision: DeferredObjectiveActivePlanRevisionV1): string | null => {
  const expected = revision.energyExpectedKWh;
  const needed = revision.energyNeededKWh;
  if (isFiniteNumber(expected) && expected > 0 && needed > 0 && Math.abs(expected - needed) > 0.05) {
    const low = Math.round(Math.min(expected, needed) * 10) / 10;
    const high = Math.round(Math.max(expected, needed) * 10) / 10;
    return `≈${low.toFixed(1)}–${high.toFixed(1)} kWh`;
  }
  if (needed > 0) return `≈${formatKwh(needed)}`;
  return null;
};

const formatPlanMetaLabel = (revision: DeferredObjectiveActivePlanRevisionV1): string | null => {
  const parts = [
    resolveDurationPart(revision),
    resolveSpeedPart(revision),
    resolveEnergyPart(revision),
  ].filter((part): part is string => part !== null && part !== '');
  if (parts.length === 0) return null;
  // Prefix (from shared-domain so smart-task copy stays single-sourced) names the
  // dense duration · power · energy run-on as a forward estimate; the renderer lifts
  // this line to full text contrast to match.
  return `${SMART_TASK_WIDGET_PLAN_META_LABEL_PREFIX} ${parts.join(' · ')}`;
};

const resolveConfidenceLabel = (
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined,
  statusId: SmartTaskListStatusId,
): string | null => (
  formatSmartTaskListConfidenceChipLabel({
    confidence: provenance?.displayConfidence ?? provenance?.confidence ?? null,
    statusId,
    learning: resolveSmartTaskLearning(provenance),
  })
);

export type SmartTasksWidgetInput = {
  activePlans: DeferredObjectiveActivePlansV1 | null;
  // Finalized plan history (all devices). The "Recently ended" section is built
  // from entries that finalized within `ENDED_WINDOW_MS`. Null/absent when the
  // recorder isn't wired — the section is simply empty.
  history?: SettingsUiDeferredObjectivePlanHistoryPayload | null;
  devices: ReadonlyArray<TargetDeviceSnapshot>;
  nowMs: number;
  timeZone?: string | null;
};

const emptyPayload = (subtitle: string, hint: string | null): SmartTasksWidgetEmptyPayload => ({
  state: 'empty',
  subtitle,
  hint,
});

type Candidate = {
  row: SmartTasksWidgetRow;
  tier: number;
  etaMs: number | null;
  deadlineMs: number;
};

const compareCandidates = (a: Candidate, b: Candidate): number => {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const aEta = a.etaMs ?? Number.POSITIVE_INFINITY;
  const bEta = b.etaMs ?? Number.POSITIVE_INFINITY;
  if (aEta !== bEta) return aEta - bEta;
  if (a.deadlineMs !== b.deadlineMs) return a.deadlineMs - b.deadlineMs;
  return 0;
};

const resolveStatusId = (
  plan: DeferredObjectiveActivePlanV1,
  nowMs: number,
): SmartTaskListStatusId => (
  resolveSmartTaskListStatus({
    pending: plan.pending || plan.latest === null,
    pendingReason: plan.pendingReason,
    diagnosticReasonCode: plan.diagnosticReasonCode,
    planStatus: plan.latest?.planStatus,
    firstActionAtMs: plan.latest?.hours[0]?.startsAtMs ?? null,
    nowMs,
  })
);

// The producer-resolved copy/visibility decisions for one row, split out of
// `buildRow` so that function stays under the complexity bar.
type RowCopy = {
  planMetaLabel: string | null;
  confidenceLabel: string | null;
  whyLabel: string | null;
  recourseHint: string | null;
};

const resolveRowCopy = (
  plan: DeferredObjectiveActivePlanV1,
  statusId: SmartTaskListStatusId,
  firstPlannedTimeLabel: string | null,
): RowCopy => {
  const detail = resolveSmartTaskWidgetDetailCopy({
    statusId,
    pendingReason: plan.pendingReason,
    floorShortfallCause: plan.latest?.floorShortfallCause,
    dailyBudgetExhaustedBucketCount: plan.latest?.dailyBudgetExhaustedBucketCount,
    firstPlannedTimeLabel,
  });
  // Suppress the receipt-flavoured plan-meta line on a failing task: the
  // diagnosis ("why" + recourse) is what the distressed visitor came for, and
  // dropping the meta keeps the 220 px detail panel from pushing the recourse
  // below the fold (asymmetric-treatment thesis, notes/smart-task-ui).
  const suppressPlanMeta = statusId === 'cannot_meet' || !plan.latest;
  // "Estimating" alongside "Waiting for tomorrow's prices" reads as two
  // conflicting blocked states; the price-wait reason owns the row here.
  const suppressConfidence = statusId === 'building_plan'
    && plan.pendingReason === 'awaiting_horizon_plan';
  return {
    planMetaLabel: suppressPlanMeta || plan.latest === null ? null : formatPlanMetaLabel(plan.latest),
    confidenceLabel: suppressConfidence
      ? null
      : resolveConfidenceLabel(plan.kwhPerUnitProvenance, statusId),
    whyLabel: detail.whyLabel,
    recourseHint: detail.recourseHint,
  };
};

const buildRow = (params: {
  deviceId: string;
  plan: DeferredObjectiveActivePlanV1;
  device: TargetDeviceSnapshot | undefined;
  targetValue: number;
  statusId: SmartTaskListStatusId;
  finishMs: number | null;
  nowMs: number;
  timeZone: string | null;
}): SmartTasksWidgetRow => {
  const { deviceId, plan, device, targetValue, statusId, finishMs, nowMs, timeZone } = params;
  const finiteFinish = isFiniteNumber(finishMs) ? finishMs : null;
  const firstHourMs = plan.latest?.hours[0]?.startsAtMs ?? null;
  const firstPlannedTimeLabel = isFiniteNumber(firstHourMs)
    ? formatLocalHHMM(firstHourMs, timeZone)
    : null;
  const copy = resolveRowCopy(plan, statusId, firstPlannedTimeLabel);
  const currentValue = resolveCurrentValue(device, plan.objectiveKind);
  return {
    deviceId,
    deviceName: device?.name ?? plan.deviceName ?? deviceId,
    kind: plan.objectiveKind,
    unitSymbol: plan.objectiveKind === 'temperature' ? '°C' : '%',
    currentValue,
    targetValue,
    finishLabel: finiteFinish !== null ? formatLocalHHMM(finiteFinish, timeZone) : null,
    statusLabel: SMART_TASK_WIDGET_STATUS_LABELS[statusId],
    tone: STATUS_TONE[statusId],
    etaVerb: resolveSmartTaskWidgetEtaVerb(statusId === 'cannot_meet'),
    targetActionVerb: resolveSmartTaskWidgetTargetActionVerb(plan.objectiveKind),
    targetNoun: SMART_TASK_WIDGET_TARGET_NOUN,
    deadlineLongLabel: finiteFinish !== null ? formatDeadlineLong(finiteFinish, nowMs, timeZone) : null,
    planMetaLabel: copy.planMetaLabel,
    confidenceLabel: copy.confidenceLabel,
    whyLabel: copy.whyLabel,
    recourseHint: copy.recourseHint,
    chart: toWidgetChart(resolveActivePlanChartData(plan, { nowMs, currentValue })),
  };
};

const buildCandidate = (params: {
  deviceId: string;
  plan: DeferredObjectiveActivePlanV1;
  devicesById: Map<string, TargetDeviceSnapshot>;
  nowMs: number;
  timeZone: string | null;
}): Candidate | null => {
  const { deviceId, plan, devicesById, nowMs, timeZone } = params;
  if (!isFiniteNumber(plan.deadlineAtMs)) return null;
  const statusId = resolveStatusId(plan, nowMs);
  if (statusId === 'satisfied') return null;
  const targetValue = resolveTargetValue(plan);
  if (targetValue === null) return null;
  const etaMs = resolvePlannerEtaMs(plan);
  const row = buildRow({
    deviceId,
    plan,
    device: devicesById.get(deviceId),
    targetValue,
    statusId,
    finishMs: plan.deadlineAtMs,
    nowMs,
    timeZone,
  });
  return { row, tier: STATUS_TIER[statusId], etaMs, deadlineMs: plan.deadlineAtMs };
};

const resolveEndedTarget = (entry: DeferredObjectivePlanHistoryEntry): number | null => {
  if (entry.objectiveKind === 'temperature') {
    return isFiniteNumber(entry.targetTemperatureC) ? entry.targetTemperatureC : null;
  }
  return isFiniteNumber(entry.targetPercent) ? entry.targetPercent : null;
};

// A missed run is budget-bound when the recorded plan snapshot saw the daily
// budget exhausted; otherwise it's device/shortfall-bound. Drives which
// (hard-cap-safe) recourse hint applies — mirrors `resolveMissedHistoryRecourse`.
const endedRunWasBudgetBound = (entry: DeferredObjectivePlanHistoryEntry): boolean => (
  ((entry.finalPlan ?? entry.originalPlan)?.dailyBudgetExhaustedBucketCount ?? 0) > 0
);

// Missed → budget/device recourse hint (reusing the active cannot-finish copy);
// every other outcome carries no recourse.
const resolveEndedRecourse = (entry: DeferredObjectivePlanHistoryEntry): string | null => {
  if (entry.outcome !== 'missed') return null;
  return endedRunWasBudgetBound(entry) ? RECOURSE_CANNOT_MEET_BUDGET : RECOURSE_CANNOT_MEET_DEVICE;
};

const buildEndedRow = (
  entry: DeferredObjectivePlanHistoryEntry,
  devicesById: Map<string, TargetDeviceSnapshot>,
  nowMs: number,
  timeZone: string | null,
): SmartTasksWidgetEndedRow | null => {
  const targetValue = resolveEndedTarget(entry);
  if (targetValue === null) return null;
  return {
    id: entry.id,
    deviceId: entry.deviceId,
    deviceName: devicesById.get(entry.deviceId)?.name ?? entry.deviceName ?? entry.deviceId,
    unitSymbol: entry.objectiveKind === 'temperature' ? '°C' : '%',
    targetValue,
    targetActionVerb: resolveSmartTaskWidgetTargetActionVerb(entry.objectiveKind),
    outcomeLabel: getPlanHistoryOutcomeLabel(entry.outcome),
    // The history tone vocabulary ('ok' | 'warn' | 'muted') is a subset of the
    // widget tone union, so it maps straight through with no 'danger' case.
    outcomeTone: getPlanHistoryOutcomeTone(entry.outcome),
    finishedLabel: formatDeadlineLong(entry.finalizedAtMs, nowMs, timeZone),
    // Canonical history copy — same helpers the settings-UI history list/detail
    // use, so wording stays single-sourced.
    progressLabel: formatPlanHistoryProgressLine(entry),
    reachedAtLabel: formatPlanHistoryReachedAtLine(entry, timeZone ?? 'UTC'),
    whyLabel: formatPlanHistoryMissedReason(entry),
    recourseHint: resolveEndedRecourse(entry),
    chart: toWidgetChart(resolveHistoryDetailChartData(entry)),
  };
};

// Collect tasks that finalized within `ENDED_WINDOW_MS` across all devices,
// newest-finalized first, capped at `ENDED_ROW_CAP`. The history payload is
// already sorted newest-first per device, but entries from different devices
// must be re-merged, so we sort the flattened list explicitly.
const buildEndedRows = (
  history: SettingsUiDeferredObjectivePlanHistoryPayload | null | undefined,
  devicesById: Map<string, TargetDeviceSnapshot>,
  nowMs: number,
  timeZone: string | null,
): SmartTasksWidgetEndedRow[] => {
  const byDevice = history?.entriesByDeviceId;
  if (!byDevice) return [];
  const cutoffMs = nowMs - ENDED_WINDOW_MS;
  const recent = Object.values(byDevice)
    .flat()
    .filter((entry) => isFiniteNumber(entry.finalizedAtMs)
      && entry.finalizedAtMs >= cutoffMs
      && entry.finalizedAtMs <= nowMs);
  // Filter unrenderable entries (null target) BEFORE the cap so a junk entry in
  // the newest slots can't displace a valid older row out of the capped list.
  return [...recent]
    .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs)
    .map((entry) => buildEndedRow(entry, devicesById, nowMs, timeZone))
    .filter((row): row is SmartTasksWidgetEndedRow => row !== null)
    .slice(0, ENDED_ROW_CAP);
};

export const buildSmartTasksWidgetPayload = (input: SmartTasksWidgetInput): SmartTasksWidgetPayload => {
  const devicesById = new Map<string, TargetDeviceSnapshot>(
    input.devices.map((device) => [device.id, device]),
  );
  const timeZone = input.timeZone ?? null;
  const endedRows = buildEndedRows(input.history, devicesById, input.nowMs, timeZone);

  const plans = input.activePlans?.plansByDeviceId;
  const candidates = plans
    ? Object.entries(plans)
      .map(([deviceId, plan]) => (plan
        ? buildCandidate({ deviceId, plan, devicesById, nowMs: input.nowMs, timeZone })
        : null))
      .filter((candidate): candidate is Candidate => candidate !== null)
    : [];

  // Empty only when there is nothing to show in EITHER section.
  if (candidates.length === 0 && endedRows.length === 0) {
    return emptyPayload(EMPTY_SUBTITLE_DEFAULT, SMART_TASK_WIDGET_EMPTY_HINT);
  }

  const sorted = [...candidates].sort(compareCandidates);
  const top = sorted.slice(0, ROW_CAP);
  const overflowCount = Math.max(0, sorted.length - top.length);

  return {
    state: 'ready',
    rows: top.map((candidate) => candidate.row),
    overflowCount,
    endedRows,
  };
};
