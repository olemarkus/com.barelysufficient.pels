import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
  DeferredHoldCause,
} from '../../../packages/planner-types/src/deferredDecoration';
import { addPerfDuration } from '../../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../../utils/opRssTracker';
import {
  applyDeferredAdmissionToInput,
  applyDeferredObjectiveAdmission,
  buildDeferredDemandDeviceIds,
  buildDeferredReleaseIntents,
  type DeferredAdmissionDecision,
} from './admission';
import {
  buildDeferredObjectiveTaskResults,
  buildTaskEvaluationSnapshot,
  LIVE_LANE,
  type TaskEvaluationReport,
  type TaskEvaluationSource,
} from './diagnosticsBridge';
import { buildSmartTaskCycleRecord, type SmartTaskCycleRecord } from './smartTaskCycleRecord';
import type { DeferredObjectiveRoster } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { PriorityAllocationTracker } from './priorityAllocation';

/**
 * Smart-task (deferred-objective) controller decoration stage. Owns the
 * concurrent-eligibility tracker and turns the raw planner input into a
 * `DeferredDecorationBundle` the planner consumes while staying
 * smart-task-agnostic. This is the input-mutation half of the controller
 * extraction: it evaluates objectives and applies admission / target-overrides /
 * release-intents to the device list. The active-plan RECORD (revisions) is
 * written on the lifecycle clock, not here; this stage only reads the committed
 * plan to decorate.
 *
 * The home's `TaskEvaluationSource` supplies the live household context (power
 * tracker, price-optimization flag, power limits, time zone, active plans) and
 * the objective roster comes from its own reader, so the planner does not
 * thread smart-task concerns through its own dependency surface. The daily-budget
 * snapshot arrives with `decorate(input)` and is only the budget overlay.
 */
export class DeferredObjectiveDecorationController {
  private readonly priorityAllocationTracker = new PriorityAllocationTracker();
  // The latest cycle's decision per live task, for diagnostics reports only.
  // Replaced whole each cycle, so an ended task drops out with it.
  private latestCycles: ReadonlyMap<string, SmartTaskCycleRecord> = new Map();

  constructor(
    private readonly source: TaskEvaluationSource,
    private readonly getDeferredObjectiveSettings: () => DeferredObjectiveRoster | undefined,
  ) {}

  public decorate(input: DeferredDecorationInput): DeferredDecorationBundle {
    const { devices, dailyBudgetSnapshot, nowTs } = input;
    const reports = this.evaluate(devices, dailyBudgetSnapshot, nowTs);
    const evaluations = reports.map((report) => report.evaluation);
    // The active-plan RECORD (revisions) is written on the lifecycle clock
    // (`DeferredObjectiveLifecycleEmitter`), not here. This stage only READS the
    // committed plan (via the diagnostics build above, which consults
    // `resolveCommittedHours`) to decorate the device inputs — reading is free
    // every cycle; only the write rides the clock. See the carve-out note.
    const decisions = applyDeferredObjectiveAdmission(evaluations, devices);
    const admission = applyDeferredAdmissionToInput(devices, decisions);
    this.latestCycles = recordCycles(reports, decisions, nowTs);
    return {
      admittedDevices: admission.devices,
      forceShedSet: admission.forceShedSet,
      deferredHoldCauseByDeviceId: resolveDeferredHoldCauses(decisions),
      deferredReleaseIntentByDeviceId: buildDeferredReleaseIntents(decisions),
      admittedDeviceIds: resolveAdmittedDeviceIds(decisions),
      drivingDeviceIds: buildDeferredDemandDeviceIds(decisions),
      lentAuthorityDeviceIds: admission.lentAuthorityDeviceIds,
      externalOffHoldLiftedDeviceIds: admission.externalOffHoldLiftedDeviceIds,
    };
  }

  /** The latest cycle's decision for the device's task; `undefined` with no live task. */
  public readLatestCycle(deviceId: string): SmartTaskCycleRecord | undefined {
    return this.latestCycles.get(deviceId);
  }

  private evaluate(
    devices: DeferredDecorationInput['devices'],
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
    nowTs: number,
  ): TaskEvaluationReport[] {
    // Mirrors the planner's `trackPlanStage` (duration + per-op RSS delta) so the
    // `evaluate_deferred_objectives_ms` telemetry is unchanged by the relocation;
    // per-op RSS attribution matters under PELS's tight memory ceiling.
    const start = Date.now();
    const rssBefore = safeRss();
    try {
      const settings = this.getDeferredObjectiveSettings();
      if (!settings) return [];
      // The lifecycle clock may not have disarmed an elapsed task yet. Its
      // terminal fallback belongs to that clock; it has no admission claims.
      return buildDeferredObjectiveTaskResults(
        buildTaskEvaluationSnapshot(this.source, nowTs, devices, settings, dailyBudgetSnapshot),
        this.source, this.priorityAllocationTracker, LIVE_LANE,
      ).filter((report) => report.evaluation.deadlineAtMs > nowTs);
    } finally {
      addPerfDuration('evaluate_deferred_objectives_ms', Date.now() - start);
      recordOpRssDelta('evaluate_deferred_objectives_ms', rssBefore, safeRss());
    }
  }
}

const recordCycles = (
  reports: readonly TaskEvaluationReport[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  nowTs: number,
): ReadonlyMap<string, SmartTaskCycleRecord> => {
  const records = new Map<string, SmartTaskCycleRecord>();
  for (const { diagnostic } of reports) {
    const decision = decisions.get(diagnostic.deviceId);
    if (decision) records.set(diagnostic.deviceId, buildSmartTaskCycleRecord(diagnostic, decision, nowTs));
  }
  return records;
};

// Devices whose deferred objective is currently GOVERNING them: a `planned` or
// `idle` admission decision this cycle. Consumed by the planner as
// `admittedDeviceIds` — the surplus dump-load hold
// (`planBuilderSurplus` → `shedding/surplusHold`) exempts a governed device.
//
// `inactive` (a task with no plan this cycle) is excluded so a smart task that
// cannot plan does not keep a device out of the hold. A satisfied task still
// governs until its deadline, which ends it.
//
// A `planned` hour booked at 0 kWh is governed too: the task booked it on price (or
// needs every hour because it cannot finish), so during an active task it decides
// whether the device runs, also on grid import for a "Run on solar surplus" device
// (owner ruling 2026-09-25: during an active smart task, the task decides).
const resolveAdmittedDeviceIds = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): ReadonlySet<string> => {
  const admitted = new Set<string>();
  for (const [deviceId, decision] of decisions) {
    if (decision.kind === 'planned' || decision.kind === 'idle') admitted.add(deviceId);
  }
  return admitted;
};

// Devices whose smart task is waiting out this hour: the admission decision is
// `idle`, which is exactly when the task holds the device (`applyDeferredAdmissionToInput`).
// Used downstream by `normalizeShedReasons` to render the task's reason for a device
// that ends up held, since the task is what holds it: "Waiting for cheaper hours"
// while it still has energy to deliver, the done line once it reached its target.
//
// It reads the decision, not the task's status: an `at_risk` task (the normal state of
// a stepped water heater, `feasible_above_floor`) holds its device in a released hour
// just as an `on_track` one does, so the same words apply. The task's own status is
// shown on the task.
export const resolveDeferredHoldCauses = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): Map<string, DeferredHoldCause> => {
  const holdCauses = new Map<string, DeferredHoldCause>();
  for (const [deviceId, decision] of decisions) {
    if (decision.kind === 'idle') holdCauses.set(deviceId, decision.holdCause);
  }
  return holdCauses;
};
