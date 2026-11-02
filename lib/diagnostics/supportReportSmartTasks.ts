import type {
  DeferredObjectiveActivePlanRevisionV1, DeferredObjectiveActivePlanV1, DeferredObjectivePlanInterval,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanHistoryRecord } from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type {
  DeferredObjectiveRescuePermissions, DeferredObjectiveSettingsEntry,
} from '../../packages/contracts/src/deferredObjectiveSettings';
import type { Schedule, ScheduleEntry, SchedulesSnapshot } from '../../packages/contracts/src/schedules';
import type { SupportReportSection, SupportReportValue } from '../../packages/contracts/src/supportReport';
import type { TaskDeliveryExplanation, TaskDeliveryInterval } from '../../packages/contracts/src/taskDelivery';
import { hoursWithPlannedEnergy } from '../../packages/shared-domain/src/deferredPlanBookedHours';
import { pickScheduledHours } from '../../packages/shared-domain/src/deferredPlanHistoryShared';
import { plannedDurationHours } from '../objectives/deferredObjectives/plannedDuration';
import type { DeferredObjectivePlanHistoryRecorder } from '../objectives/deferredObjectives/planHistory';
import type { SmartTaskCycleRecord } from '../objectives/deferredObjectives/smartTaskCycleRecord';
import { present } from './supportReportProjection';

/**
 * The fields of a task's recorded plan the report states: its decision, the
 * learned rate behind it and the latest revision. Narrowed so a capture hands
 * over one device's record, never the assembled UI view of every task.
 */
export type SupportReportSmartTaskPlan = Pick<DeferredObjectiveActivePlanV1,
  'pending' | 'pendingReason' | 'diagnosticReasonCode' | 'kwhPerUnitProvenance'> & {
  latest: Pick<DeferredObjectiveActivePlanRevisionV1,
    'planStatus' | 'energyNeededKWh' | 'hours' | 'revisedAtMs' | 'reason' | 'floorShortfallCause'> | null;
};

/** A device's saved smart task with what the planner and the controller hold for it. */
export type SupportReportPresentSmartTask = {
  state: 'present';
  entry: DeferredObjectiveSettingsEntry;
  /** `undefined` when the planner holds no plan for the task yet. */
  plan: SupportReportSmartTaskPlan | undefined;
  /** `undefined` before the controller's first cycle with this task. */
  cycle: SmartTaskCycleRecord | undefined;
};

/** The subject device's smart task as capture read it. An unreadable store throws instead. */
export type SupportReportSmartTask = { state: 'none' } | SupportReportPresentSmartTask;

/** One saved smart task in an app report, by device. */
export type SupportReportDeviceSmartTask = {
  deviceId: string;
  task: SupportReportPresentSmartTask;
};

/**
 * A finalized run as the history recorder keeps it, with the recorder's own
 * verdict on whether the daily budget alone caused a miss.
 */
export type SupportReportSmartTaskRun = {
  record: DeferredObjectivePlanHistoryRecord;
  budgetOnlyMiss: boolean;
};

/** The kept runs, each with whether the recorder classed it as a budget-only miss. */
export const readSmartTaskRuns = (
  recorder: Pick<DeferredObjectivePlanHistoryRecorder, 'getHistorySnapshot' | 'getBudgetOnlyMisses'>,
): SupportReportSmartTaskRun[] => {
  const budgetOnly = new Set(recorder.getBudgetOnlyMisses().map((miss) => miss.id));
  return recorder.getHistorySnapshot().entries.map((record) => ({ record, budgetOnlyMiss: budgetOnly.has(record.id) }));
};

/** At most this many finalized runs in a report about the whole app: the newest in its window. */
export const SUPPORT_REPORT_MAX_SMART_TASK_RUNS = 12;
/** At most this many of one device's finalized runs in a report about that device: its newest. */
export const SUPPORT_REPORT_MAX_DEVICE_SMART_TASK_RUNS = 5;
/** At most this many blocked intervals per run: the longest, kept in time order. */
export const SUPPORT_REPORT_MAX_BLOCKED_INTERVALS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** Energy to the watt-hour; a report has no use for float noise. */
const kWh = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Energy per UTC hour, each interval's energy shared over the hours it spans by
 * overlap, so a booking and the delivery in the same interval land in the same
 * rows even when the interval crosses an hour.
 */
const sumByHour = (
  intervals: readonly { fromMs: number; toMs: number; kWh: number }[],
): Map<number, number> => intervals.reduce((byHour, { fromMs, toMs, kWh: energy }) => {
  const spanMs = toMs - fromMs;
  if (spanMs <= 0) {
    const hour = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
    return byHour.set(hour, (byHour.get(hour) ?? 0) + energy);
  }
  for (let hour = Math.floor(fromMs / HOUR_MS) * HOUR_MS; hour < toMs; hour += HOUR_MS) {
    const overlapMs = Math.min(toMs, hour + HOUR_MS) - Math.max(fromMs, hour);
    byHour.set(hour, (byHour.get(hour) ?? 0) + energy * (overlapMs / spanMs));
  }
  return byHour;
}, new Map<number, number>());

/**
 * A plan's bookings as `[hourStartMs, plannedKWh]` rows. A booked hour at 0 kWh
 * stays: it lets the task start its device on capacity that is actually free.
 */
const reportHourlyBookings = (hours: readonly DeferredObjectivePlanInterval[]): SupportReportValue[] => (
  [...sumByHour(hours.map((hour) => ({
    fromMs: hour.coversFromMs ?? hour.startsAtMs, toMs: hour.endsAtMs, kWh: hour.plannedKWh,
  })))]
    .sort(([a], [b]) => a - b)
    .map(([hour, planned]) => [hour, kWh(planned)])
);

const savedPermissions = (rescue: DeferredObjectiveRescuePermissions | undefined): SupportReportValue => ({
  ...present('exemptFromBudget', rescue?.exemptFromBudget),
  ...present('limitLowerPriorityDevices', rescue?.limitLowerPriorityDevices),
  ...present('pauseLowerPriorityDevices', rescue?.pauseLowerPriorityDevices),
});

const reportSmartTaskGoal = (entry: DeferredObjectiveSettingsEntry): Record<string, SupportReportValue> => {
  if (entry.kind === 'ev_soc') return { targetPercent: entry.targetPercent };
  if (entry.kind === 'temperature') return { targetTemperatureC: entry.targetTemperatureC };
  return { targetEnergyKWh: entry.targetEnergyKWh };
};

const reportSmartTaskRevision = (
  revision: NonNullable<SupportReportSmartTaskPlan['latest']>,
  capturedAtMs: number,
): Record<string, SupportReportValue> => {
  // Saved hours are bookings; a booking at 0 kWh still lets the task start its
  // device, so whether this hour is booked is reported apart from its energy.
  const running = hoursWithPlannedEnergy(revision.hours);
  const currentHour = revision.hours.find((hour) => (
    (hour.coversFromMs ?? hour.startsAtMs) <= capturedAtMs && capturedAtMs < hour.endsAtMs
  ));
  const nextHour = running.find((hour) => hour.startsAtMs > capturedAtMs);
  return {
    planStatus: revision.planStatus,
    revisedAtMs: revision.revisedAtMs,
    revisionReason: revision.reason,
    energyNeededKWh: revision.energyNeededKWh,
    ...present('floorShortfallCause', revision.floorShortfallCause),
    plannedHours: plannedDurationHours(revision.hours),
    currentHourBooked: currentHour !== undefined,
    ...present('currentHourPlannedKWh', currentHour?.plannedKWh),
    ...present('nextPlannedHourStartsAtMs', nextHour?.startsAtMs),
    hourlyBookings: reportHourlyBookings(revision.hours),
  };
};

const reportSmartTaskPlan = (
  plan: SupportReportSmartTaskPlan,
  capturedAtMs: number,
): Record<string, SupportReportValue> => ({
  pending: plan.pending,
  ...present('pendingReason', plan.pendingReason),
  ...present('diagnosticReasonCode', plan.diagnosticReasonCode),
  ...(plan.kwhPerUnitProvenance ? {
    learnedRateSource: plan.kwhPerUnitProvenance.source,
    learnedRateSamples: plan.kwhPerUnitProvenance.acceptedSamples,
    ...present('learnedRateConfidence', plan.kwhPerUnitProvenance.confidence ?? undefined),
  } : {}),
  ...(plan.latest ? reportSmartTaskRevision(plan.latest, capturedAtMs) : { revision: 'none' }),
});

// The controller's latest decision: `planned` lets the task start its device,
// `idle` holds it (`holdCause`), `inactive` names the missing precondition in
// `reasonCode`. This is what a report on "why does it not run" turns on.
const reportSmartTaskCycle = (cycle: SmartTaskCycleRecord): Record<string, SupportReportValue> => ({
  atMs: cycle.atMs,
  decision: cycle.decision,
  ...present('holdCause', cycle.holdCause),
  reasonCode: cycle.reasonCode,
  trajectory: cycle.trajectory,
  currentValue: cycle.currentValue,
  energyNeededKWh: cycle.energyNeededKWh,
  planningSpeedKw: cycle.planningSpeedKw,
  kwhPerUnitSource: cycle.kwhPerUnitSource,
  kwhPerUnitAcceptedSamples: cycle.kwhPerUnitAcceptedSamples,
  budgetExempt: cycle.budgetExempt,
  ...present('engageBoost', cycle.engageBoost),
  ...present('reservesStartupPower', cycle.reservesStartupPower),
  ...present('liveStepsUnavailable', cycle.liveStepsUnavailable),
  permissionsInForce: [...cycle.permissionsInForce ?? []],
});

const reportPresentSmartTask = (
  { entry, plan, cycle }: SupportReportPresentSmartTask,
  capturedAtMs: number,
): Record<string, SupportReportValue> => ({
  kind: entry.kind,
  enabled: entry.enabled,
  enforcement: entry.enforcement,
  deadlineAtMs: entry.deadlineAtMs,
  ...reportSmartTaskGoal(entry),
  // What the owner let the task override; `at_risk` applies only once the task would miss.
  savedPermissions: savedPermissions(entry.rescue),
  ...present('schedule', entry.scheduleSource && { id: entry.scheduleSource.id, name: entry.scheduleSource.name }),
  plan: plan ? reportSmartTaskPlan(plan, capturedAtMs) : 'none',
  lastCycle: cycle ? reportSmartTaskCycle(cycle) : 'none',
});

const HOURLY_BOOKING_COLUMNS = ['hourStartMs', 'plannedKWh'];

/**
 * Whether the subject has a smart task, what the planner recorded for it and
 * what the controller decided last cycle. "No smart task" is evidence too: a
 * device held by "Only PELS starts this device" without one is off by design,
 * which nothing else in a report says.
 */
export const reportSmartTask = (read: SupportReportSmartTask, capturedAtMs: number): SupportReportSection => (
  read.state === 'none' ? { title: 'Current smart task', values: { exists: false } } : {
    title: 'Current smart task',
    values: {
      exists: true, ...reportPresentSmartTask(read, capturedAtMs), hourlyBookingColumns: HOURLY_BOOKING_COLUMNS,
    },
  }
);

/** Every saved smart task in Main, for a report about the whole app. */
export const reportSmartTasks = (
  tasks: readonly SupportReportDeviceSmartTask[],
  deviceName: (deviceId: string) => string | undefined,
  capturedAtMs: number,
): SupportReportSection => ({
  title: 'Current smart tasks',
  values: {
    hourlyBookingColumns: HOURLY_BOOKING_COLUMNS,
    tasks: tasks.map(({ deviceId, task }) => ({
      deviceId, ...present('deviceName', deviceName(deviceId)), ...reportPresentSmartTask(task, capturedAtMs),
    })),
  },
});

/**
 * A run's bookings beside its delivery as `[hourStartMs, bookedKWh, deliveredKWh]`.
 * `null` booked is an hour the run delivered in without a booking; `null`
 * delivered is a booked hour the recorder saw no delivery in.
 */
const reportRunHours = (record: DeferredObjectivePlanHistoryRecord): SupportReportValue[] => {
  const booked = sumByHour((pickScheduledHours(record) ?? []).map((hour) => ({
    fromMs: hour.startsAtMs, toMs: hour.endsAtMs, kWh: hour.plannedKWh,
  })));
  const delivered = sumByHour((record.hourlyContributions ?? []).map((hour) => ({
    fromMs: hour.atMs, toMs: hour.endsAtMs, kWh: hour.deliveredKWh,
  })));
  return [...new Set([...booked.keys(), ...delivered.keys()])].sort((a, b) => a - b).map((hour) => {
    const bookedKWh = booked.get(hour);
    const deliveredKWh = delivered.get(hour);
    return [
      hour, bookedKWh === undefined ? null : kWh(bookedKWh), deliveredKWh === undefined ? null : kWh(deliveredKWh),
    ];
  });
};

/** Adjacent intervals of one cause read as one. */
const mergeBlocked = (intervals: readonly TaskDeliveryInterval[]): TaskDeliveryInterval[] => (
  [...intervals].sort((a, b) => a.fromMs - b.fromMs).reduce<TaskDeliveryInterval[]>((merged, interval) => {
    const last = merged.at(-1);
    if (last && last.cause === interval.cause && interval.fromMs <= last.toMs) {
      return [...merged.slice(0, -1), { ...last, toMs: Math.max(last.toMs, interval.toMs) }];
    }
    return [...merged, interval];
  }, [])
);

/** What kept the run from delivering, as its delivery evidence recorded it. */
const reportRunConstraint = (explanation: TaskDeliveryExplanation): Record<string, SupportReportValue> => {
  if (explanation.kind === 'legacy_unrecorded') return { recorded: false };
  const merged = mergeBlocked(explanation.intervals);
  const kept = new Set([...merged].sort((a, b) => (b.toMs - b.fromMs) - (a.toMs - a.fromMs))
    .slice(0, SUPPORT_REPORT_MAX_BLOCKED_INTERVALS));
  return {
    recorded: true,
    primary: explanation.primary.kind === 'clear' ? 'clear' : explanation.primary.cause,
    contributors: [...explanation.contributors],
    blocked: merged.filter((interval) => kept.has(interval))
      .map((interval) => [interval.fromMs, interval.toMs, interval.cause]),
    blockedLeftOut: merged.length - kept.size,
  };
};

const reportRun = (
  { record, budgetOnlyMiss }: SupportReportSmartTaskRun,
  deviceName: (deviceId: string) => string | undefined,
): Record<string, SupportReportValue> => {
  const plan = record.finalPlan;
  return {
    deviceId: record.deviceId,
    ...present('deviceName', deviceName(record.deviceId)),
    kind: record.objectiveKind ?? 'unrecorded',
    target: record.targetValue,
    startValue: record.startProgressValue,
    finalValue: record.finalProgressValue,
    startedAtMs: record.startedAtMs,
    deadlineAtMs: record.deadlineAtMs,
    finalizedAtMs: record.finalizedAtMs,
    outcome: record.outcome,
    ...present('metReason', record.metReason),
    metAtMs: record.metAtMs,
    ...(record.discoveredFrom === 'backfill' ? { discoveredFrom: 'backfill' } : {}),
    ...present('neededKWh', record.initialEnergyExpectedKWh === undefined
      ? undefined : kWh(record.initialEnergyExpectedKWh)),
    ...present('deliveredKWh', record.deliveredKWh === undefined ? undefined : kWh(record.deliveredKWh)),
    ...present('cost', record.totalCost === undefined ? undefined : {
      total: record.totalCost, ...present('unit', record.costDisplay?.unit),
      ...present('divisor', record.costDisplay?.divisor),
    }),
    usedDeadlineReserve: record.usedDeadlineReserve,
    budgetOnlyMiss,
    ...present('revisionCount', record.revisionCount),
    ...(plan ? {
      finalPlanStatus: plan.planStatus,
      ...present('floorShortfallCause', plan.floorShortfallCause),
      ...present('planningSpeedKw', plan.planningSpeedKw),
    } : {}),
    constraint: reportRunConstraint(record.deliveryExplanation),
    hours: reportRunHours(record),
  };
};

/**
 * Finalized smart-task runs: what each asked for, how its hours were booked
 * beside what it delivered in them, what held it back and how it ended. Runs
 * are newest first; `leftOut` counts the older ones a report had no room for.
 */
export const reportSmartTaskRuns = (
  runs: readonly SupportReportSmartTaskRun[],
  maxRuns: number,
  deviceName: (deviceId: string) => string | undefined,
  window: { fromMs: number; toMs: number } | null,
): SupportReportSection => {
  const newest = [...runs].sort((a, b) => b.record.finalizedAtMs - a.record.finalizedAtMs);
  const kept = newest.slice(0, maxRuns);
  return {
    title: 'Smart task runs',
    values: {
      ...(window ? { fromMs: window.fromMs, toMs: window.toMs } : {}),
      hourColumns: ['hourStartMs', 'bookedKWh', 'deliveredKWh'],
      blockedColumns: ['fromMs', 'toMs', 'cause'],
      runs: kept.map((run) => reportRun(run, deviceName)),
      leftOut: newest.length - kept.length,
    },
  };
};

const scheduledPermissions = (task: Extract<Schedule['action'], { type: 'task' }>['task']): SupportReportValue => [
  ...(task.exemptFromBudget ? ['exemptFromBudget'] : []),
  ...(task.limitLowerPriorityDevices ? ['limitLowerPriorityDevices'] : []),
  ...(task.pauseLowerPriorityDevices ? ['pauseLowerPriorityDevices'] : []),
];

const reportTaskSchedule = (entry: ScheduleEntry): Record<string, SupportReportValue> | null => {
  const { schedule } = entry;
  if (schedule.action.type !== 'task') return null;
  const { task } = schedule.action;
  return {
    id: schedule.id, name: schedule.name, enabled: schedule.enabled, state: entry.state,
    ...(entry.reason ? { reason: entry.reason } : {}),
    at: schedule.at,
    repeat: schedule.repeat.type === 'weekly'
      ? { type: 'weekly', days: [...schedule.repeat.days] } : { type: 'once', date: schedule.repeat.date },
    condition: schedule.condition.type === 'any'
      ? { type: 'any' } : { type: schedule.condition.type, modes: [...schedule.condition.modes] },
    deviceId: task.deviceId, kind: task.kind, target: task.target, readyBy: task.readyByLocalTime,
    permissions: scheduledPermissions(task),
    nextAtMs: entry.nextAtMs,
    ...(entry.lastResult ? { lastResult: entry.lastResult, lastDue: entry.lastLabel } : {}),
  };
};

/**
 * The schedules that create smart tasks, with the permissions each grants the
 * tasks it creates; `deviceId` narrows them to one device's.
 */
export const reportSmartTaskSchedules = (
  snapshot: SchedulesSnapshot,
  deviceId: string | null,
): SupportReportSection => {
  const schedules = snapshot.entries.flatMap((entry) => {
    const reported = reportTaskSchedule(entry);
    return reported && (deviceId === null || reported.deviceId === deviceId) ? [reported] : [];
  });
  return {
    title: 'Smart task schedules',
    values: {
      timeZone: snapshot.timeZone,
      // Scheduled smart tasks the owner turned off per device.
      ...(deviceId === null
        ? { pausedDeviceIds: [...snapshot.controls.disabledTaskDeviceIds] }
        : { paused: snapshot.controls.disabledTaskDeviceIds.includes(deviceId) }),
      schedules,
    },
  };
};
