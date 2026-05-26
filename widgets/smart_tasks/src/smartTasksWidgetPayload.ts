import type {
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import {
  resolveSmartTaskListStatus,
  SMART_TASK_LIST_STATUS_LABELS,
  type SmartTaskListStatusId,
} from '../../../packages/shared-domain/src/deadlineLabels';
import type {
  SmartTasksWidgetEmptyPayload,
  SmartTasksWidgetPayload,
  SmartTasksWidgetRow,
  SmartTasksWidgetTone,
} from './smartTasksWidgetTypes';

export const ROW_CAP = 3;
export const EMPTY_SUBTITLE_DEFAULT = 'No active smart tasks';

// Sort tier per status. Lower number = higher priority (rendered first).
// Satisfied is excluded from the widget before sorting; the entry is kept here
// only so the map is total over the union.
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

// Planner ETA = end of the last scheduled hour (`startsAtMs + 1h`). Returns
// null when no hours are scheduled — the caller falls back to the deadline.
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

export type SmartTasksWidgetInput = {
  activePlans: DeferredObjectiveActivePlansV1 | null;
  devices: ReadonlyArray<TargetDeviceSnapshot>;
  nowMs: number;
  timeZone?: string | null;
};

const emptyPayload = (subtitle: string): SmartTasksWidgetEmptyPayload => ({
  state: 'empty',
  subtitle,
});

type Candidate = {
  row: SmartTasksWidgetRow;
  tier: number;
  etaMs: number | null;
  deadlineMs: number;
};

const compareCandidates = (a: Candidate, b: Candidate): number => {
  if (a.tier !== b.tier) return a.tier - b.tier;
  // Tie-break 1: ETA ascending (null sorts last within a tier).
  const aEta = a.etaMs ?? Number.POSITIVE_INFINITY;
  const bEta = b.etaMs ?? Number.POSITIVE_INFINITY;
  if (aEta !== bEta) return aEta - bEta;
  // Tie-break 2: deadline ascending.
  if (a.deadlineMs !== b.deadlineMs) return a.deadlineMs - b.deadlineMs;
  return 0;
};

const resolveStatusId = (plan: DeferredObjectiveActivePlanV1, nowMs: number): SmartTaskListStatusId => (
  resolveSmartTaskListStatus({
    pending: plan.pending || plan.latest === null,
    pendingReason: plan.pendingReason,
    diagnosticReasonCode: plan.diagnosticReasonCode,
    planStatus: plan.latest?.planStatus,
    firstActionAtMs: plan.latest?.hours[0]?.startsAtMs ?? null,
    nowMs,
  })
);

const buildRow = (params: {
  deviceId: string;
  plan: DeferredObjectiveActivePlanV1;
  device: TargetDeviceSnapshot | undefined;
  targetValue: number;
  statusId: SmartTaskListStatusId;
  finishMs: number | null;
  timeZone: string | null;
}): SmartTasksWidgetRow => {
  const { deviceId, plan, device, targetValue, statusId, finishMs, timeZone } = params;
  const finiteFinish = isFiniteNumber(finishMs) ? finishMs : null;
  return {
    deviceId,
    deviceName: device?.name ?? plan.deviceName ?? deviceId,
    kind: plan.objectiveKind,
    unitSymbol: plan.objectiveKind === 'temperature' ? '°C' : '%',
    currentValue: resolveCurrentValue(device, plan.objectiveKind),
    targetValue,
    finishLabel: finiteFinish !== null ? formatLocalHHMM(finiteFinish, timeZone) : null,
    statusLabel: SMART_TASK_LIST_STATUS_LABELS[statusId],
    tone: STATUS_TONE[statusId],
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
    finishMs: etaMs ?? plan.deadlineAtMs,
    timeZone,
  });
  return { row, tier: STATUS_TIER[statusId], etaMs, deadlineMs: plan.deadlineAtMs };
};

export const buildSmartTasksWidgetPayload = (input: SmartTasksWidgetInput): SmartTasksWidgetPayload => {
  const plans = input.activePlans?.plansByDeviceId;
  if (!plans) return emptyPayload(EMPTY_SUBTITLE_DEFAULT);

  const devicesById = new Map<string, TargetDeviceSnapshot>(
    input.devices.map((device) => [device.id, device]),
  );

  const candidates = Object.entries(plans)
    .map(([deviceId, plan]) => (plan
      ? buildCandidate({ deviceId, plan, devicesById, nowMs: input.nowMs, timeZone: input.timeZone ?? null })
      : null))
    .filter((candidate): candidate is Candidate => candidate !== null);

  if (candidates.length === 0) return emptyPayload(EMPTY_SUBTITLE_DEFAULT);

  const sorted = [...candidates].sort(compareCandidates);
  const top = sorted.slice(0, ROW_CAP);
  const overflowCount = Math.max(0, sorted.length - top.length);

  return {
    state: 'ready',
    rows: top.map((candidate) => candidate.row),
    overflowCount,
  };
};
