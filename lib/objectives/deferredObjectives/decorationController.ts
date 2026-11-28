import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
  DeferredHoldCause,
  ChargingPhaseTaskRequirement,
} from '../../../packages/planner-types/src/deferredDecoration';
import type { PlanInputDevice } from '../../../packages/planner-types/src/planInputDevice';
import { addPerfDuration } from '../../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../../utils/opRssTracker';
import {
  applyDeferredAdmissionToInput,
  buildBatteryDischargePause,
  followsSurplusWhileWaiting,
  applyDeferredObjectiveAdmission,
  buildDeferredDemandDeviceIds,
  buildDeferredReleaseIntents,
  type DeferredAdmissionDecision,
} from './admission';
import {
  buildDeferredObjectiveTaskResults,
  buildTaskEvaluationSnapshot,
  SERVING_LANE,
  type TaskEvaluationReport,
  type TaskEvaluationSource,
} from './diagnosticsBridge';
import { buildSmartTaskCycleRecord, type SmartTaskCycleRecord } from './smartTaskCycleRecord';
import type { DeferredObjectiveRoster } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { getDebugEmitter } from '../../logging/logger';
import { buildObjectiveSignatureForEntry } from './activePlanSignature';
import type { ChargingPhaseEnvelope } from '../../../packages/planner-types/src/chargingPhases';

import { isEvDevice } from '../../../packages/shared-domain/src/commandableNow';

const BATTERY_DISCHARGE_DEADBAND_W = 500;
const RETRY_QUARTER_MS = 15 * 60 * 1000;

const emitTaskDebug = getDebugEmitter('deferred_objectives', 'deferred_objectives');

type TaskIntervalClaim = {
  taskSignature: string;
  startsAtMs: number;
  endsAtMs: number;
};

const canPauseCharging = (decision: DeferredAdmissionDecision, device: PlanInputDevice): boolean => (
  decision.kind === 'planned'
  || (decision.kind === 'idle' && decision.holdCause === 'cheaper_hours' && followsSurplusWhileWaiting(device))
);

const isCurrentClaim = (claim: TaskIntervalClaim | undefined, signature: string, nowMs: number):
claim is TaskIntervalClaim => (
  claim?.taskSignature === signature && nowMs >= claim.startsAtMs && nowMs < claim.endsAtMs
);

const getBatteryPauseEnd = (evaluation: TaskEvaluationReport['evaluation'], nowMs: number): number => {
  if (evaluation.planning.kind === 'allocated') {
    const { plan } = evaluation.planning;
    const bucket = plan.plannedBuckets.find((entry) => entry.id === plan.currentBucket?.bucketId);
    if (bucket) return bucket.endMs;
  }
  return (Math.floor(nowMs / RETRY_QUARTER_MS) + 1) * RETRY_QUARTER_MS;
};

/**
 * Smart-task (deferred-objective) controller decoration stage. Turns the raw planner input into a
 * `DeferredDecorationBundle` the planner consumes while staying
 * smart-task-agnostic. This is the input-mutation half of the controller
 * extraction: it serves committed objectives and applies admission / target-overrides /
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
  // The latest cycle's decision per live task, for diagnostics reports only.
  // Replaced whole each cycle, so an ended task drops out with it.
  private latestCycles: ReadonlyMap<string, SmartTaskCycleRecord> = new Map();
  private batteryPauses: ReadonlyMap<string, TaskIntervalClaim> = new Map();
  private budgetExemptClaims: ReadonlyMap<string, TaskIntervalClaim> = new Map();

  constructor(
    private readonly source: TaskEvaluationSource,
    private readonly getDeferredObjectiveSettings: () => DeferredObjectiveRoster | undefined,
    /**
     * A temperature override is in force on the device
     * (`lib/overrides/deviceOverrides.ts`). It outranks the task:
     * the task keeps its plan, but this cycle it decides nothing for the device.
     */
    private readonly isTemporaryTemperatureActive: (deviceId: string) => boolean,
  ) {}

  public decorate(input: DeferredDecorationInput): DeferredDecorationBundle {
    const { devices, dailyBudgetSnapshot, nowTs } = input;
    const settings = this.getDeferredObjectiveSettings();
    const reports = this.evaluate(devices, dailyBudgetSnapshot, nowTs, settings);
    const evaluations = reports.map((report) => report.evaluation);
    // The active-plan RECORD (revisions) is written on the lifecycle clock
    // (`DeferredObjectiveLifecycleEmitter`), not here. This stage only READS the
    // committed plan (via the diagnostics build above, which consults
    // `resolveCommittedHours`) to decorate the device inputs — reading is free
    // every cycle; only the write rides the clock. See the carve-out note.
    const admitted = this.withoutSuspendedDevices(applyDeferredObjectiveAdmission(evaluations, devices));
    const decisions = this.applyBatteryDischargePauses(admitted, reports, input, settings);
    const admission = applyDeferredAdmissionToInput(devices, decisions);
    this.latestCycles = recordCycles(reports, decisions, nowTs, this.latestCycles);
    this.budgetExemptClaims = recordBudgetExemptClaims(reports, decisions, settings, nowTs);
    return {
      chargingPhaseRequirements: resolveChargingPhaseRequirements(
        reports, decisions, this.source.getChargingPhaseEnvelopes(nowTs),
      ),
      admittedDevices: admission.devices,
      forceShedSet: admission.forceShedSet,
      deferredHoldCauseByDeviceId: resolveDeferredHoldCauses(decisions),
      deferredReleaseIntentByDeviceId: buildDeferredReleaseIntents(decisions),
      admittedDeviceIds: resolveAdmittedDeviceIds(decisions, devices),
      drivingDeviceIds: buildDeferredDemandDeviceIds(decisions),
      lentAuthorityDeviceIds: admission.lentAuthorityDeviceIds,
      externalOffHoldLiftedDeviceIds: admission.externalOffHoldLiftedDeviceIds,
    };
  }

  private batteryDischargeExceedsDeadband(): boolean {
    return (this.source.getHomeBatteryDischargeW?.() ?? 0) > BATTERY_DISCHARGE_DEADBAND_W;
  }

  private findProtectedCharger(devices: PlanInputDevice[], deviceId: string): PlanInputDevice | undefined {
    if (!this.source.evSmartTaskSettings?.(deviceId)?.pauseOnBatteryDischarge) return undefined;
    return devices.find((device) => device.id === deviceId && isEvDevice(device));
  }

  private applyBatteryDischargePauses(
    decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
    reports: readonly TaskEvaluationReport[],
    input: DeferredDecorationInput,
    settings: DeferredObjectiveRoster | undefined,
  ): ReadonlyMap<string, DeferredAdmissionDecision> {
    const { devices, nowTs } = input;
    const pauses = new Map<string, TaskIntervalClaim>();
    const result = new Map(decisions);
    let discharging: boolean | undefined;
    for (const { evaluation } of reports) {
      const { deviceId } = evaluation;
      const device = this.findProtectedCharger(devices, deviceId);
      const task = settings?.objectivesByDeviceId[deviceId];
      const decision = decisions.get(deviceId);
      if (!device || !task || !decision) continue;
      const canRun = canPauseCharging(decision, device);
      const signature = buildObjectiveSignatureForEntry(task, 'unknown');
      const prior = this.batteryPauses.get(deviceId);
      if (isCurrentClaim(prior, signature, nowTs)) {
        pauses.set(deviceId, prior);
      } else if (canRun) {
        discharging ??= this.batteryDischargeExceedsDeadband();
        if (!discharging) continue;
        pauses.set(deviceId, {
          taskSignature: signature, startsAtMs: nowTs, endsAtMs: getBatteryPauseEnd(evaluation, nowTs),
        });
      }
      if (canRun && pauses.has(deviceId)) result.set(deviceId, buildBatteryDischargePause(device));
    }
    this.batteryPauses = pauses;
    return result;
  }

  /**
   * The decisions with every device a temperature override holds left
   * out, so no floor, deferred hold, lent authority or hour claim reaches it.
   * The task is not touched: once the override ends, its next
   * decision applies as usual.
   */
  private withoutSuspendedDevices(
    decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  ): ReadonlyMap<string, DeferredAdmissionDecision> {
    const suspended = [...decisions.keys()].filter((deviceId) => this.isTemporaryTemperatureActive(deviceId));
    if (suspended.length === 0) return decisions;
    return new Map([...decisions].filter(([deviceId]) => !suspended.includes(deviceId)));
  }

  /** The latest cycle's decision for the device's task; `undefined` with no live task. */
  public readLatestCycle(deviceId: string): SmartTaskCycleRecord | undefined {
    return this.latestCycles.get(deviceId);
  }

  /**
   * Effective task exemptions for measured-energy accounting. The admission
   * decision lasts only for the native interval it resolved and the same live
   * task. This read neither evaluates tasks nor depends on plan publication.
   */
  public readBudgetExemptDeviceIds(nowMs: number): ReadonlySet<string> {
    const exempt = new Set<string>();
    let settings: DeferredObjectiveRoster | undefined;
    for (const [deviceId, claim] of this.budgetExemptClaims) {
      if (nowMs < claim.startsAtMs || nowMs >= claim.endsAtMs) continue;
      settings ??= this.getDeferredObjectiveSettings();
      if (settings === undefined) break;
      const task = settings.objectivesByDeviceId[deviceId];
      if (task?.enabled && buildObjectiveSignatureForEntry(task, 'unknown') === claim.taskSignature) {
        exempt.add(deviceId);
      }
    }
    return exempt;
  }

  private evaluate(
    devices: DeferredDecorationInput['devices'],
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
    nowTs: number,
    settings: DeferredObjectiveRoster | undefined,
  ): TaskEvaluationReport[] {
    // Mirrors the planner's `trackPlanStage` (duration + per-op RSS delta) so the
    // `evaluate_deferred_objectives_ms` telemetry is unchanged by the relocation;
    // per-op RSS attribution matters under PELS's tight memory ceiling.
    const start = Date.now();
    const rssBefore = safeRss();
    try {
      if (!settings) return [];
      // The lifecycle clock may not have disarmed an elapsed task yet. Its
      // terminal fallback belongs to that clock; it has no admission claims.
      return buildDeferredObjectiveTaskResults(
        buildTaskEvaluationSnapshot(this.source, nowTs, devices, settings, dailyBudgetSnapshot, SERVING_LANE),
        this.source, SERVING_LANE,
      ).filter((report) => report.evaluation.deadlineAtMs > nowTs);
    } finally {
      addPerfDuration('evaluate_deferred_objectives_ms', Date.now() - start);
      recordOpRssDelta('evaluate_deferred_objectives_ms', rssBefore, safeRss());
    }
  }
}

/** The horizon owns urgency: a manual boost is not a deadline power requirement. */
function resolveChargingPhaseRequirements(
  reports: readonly TaskEvaluationReport[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  envelopes: ReadonlyMap<string, readonly ChargingPhaseEnvelope[]>,
): ReadonlyMap<string, ChargingPhaseTaskRequirement> {
  const requirements = new Map<string, ChargingPhaseTaskRequirement>();
  for (const { evaluation } of reports) {
    if (decisions.get(evaluation.deviceId)?.kind !== 'planned' || evaluation.planning.kind !== 'allocated') continue;
    const { plan } = evaluation.planning;
    if (!plan.currentBucket || plan.currentBucket.plannedUsefulEnergyKWh <= 0) continue;
    const permitted = envelopes.get(evaluation.deviceId);
    if (!permitted) continue;
    const steps = permitted.flatMap((envelope) => envelope.profile.steps.map((step) => ({
      id: `${envelope.phases}p:${step.id}`, admissionPowerKw: step.planningPowerW / 1000,
    })));
    const bucket = plan.plannedBuckets.find((entry) => entry.id === plan.currentBucket?.bucketId);
    const admissionKw = bucket?.plannedAdmissionPowerKw
      ?? steps.find((step) => step.id === plan.currentBucket?.expectedStepId)?.admissionPowerKw;
    if (admissionKw === undefined || admissionKw <= 0) continue;
    let permittedMaxKw = 0;
    for (const step of steps) permittedMaxKw = Math.max(permittedMaxKw, step.admissionPowerKw);
    requirements.set(evaluation.deviceId, { admissionKw, permittedMaxKw });
  }
  return requirements;
}

const recordBudgetExemptClaims = (
  reports: readonly TaskEvaluationReport[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  settings: DeferredObjectiveRoster | undefined,
  nowMs: number,
): ReadonlyMap<string, TaskIntervalClaim> => {
  const claims = new Map<string, TaskIntervalClaim>();
  for (const { evaluation } of reports) {
    if (decisions.get(evaluation.deviceId)?.budgetExempt !== true || evaluation.planning.kind !== 'allocated') continue;
    const task = settings?.objectivesByDeviceId[evaluation.deviceId];
    const { plan } = evaluation.planning;
    const interval = plan.plannedBuckets.find((bucket) => bucket.id === plan.currentBucket?.bucketId);
    if (!task || !interval) continue;
    claims.set(evaluation.deviceId, {
      taskSignature: buildObjectiveSignatureForEntry(task, 'unknown'),
      startsAtMs: nowMs,
      endsAtMs: Math.min(interval.endMs, evaluation.deadlineAtMs),
    });
  }
  return claims;
};

const recordCycles = (
  reports: readonly TaskEvaluationReport[],
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  nowTs: number,
  previousCycles: ReadonlyMap<string, SmartTaskCycleRecord>,
): ReadonlyMap<string, SmartTaskCycleRecord> => {
  const records = new Map<string, SmartTaskCycleRecord>();
  for (const { diagnostic } of reports) {
    const decision = decisions.get(diagnostic.deviceId);
    if (!decision) continue;
    const { deviceId } = diagnostic;
    if (decision.kind === 'waiting' && previousCycles.get(deviceId)?.decision !== 'waiting') {
      emitTaskDebug({ event: 'smart_task_waiting_for_replan', deviceId, reasonCode: diagnostic.reasonCode });
    }
    records.set(deviceId, buildSmartTaskCycleRecord(diagnostic, decision, nowTs));
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
// An `idle` device on a solar-surplus posture is the exception
// (`followsSurplusWhileWaiting`): in an hour its task skips, the posture governs
// it, so the surplus allocator and the surplus hold must see it.
//
// A `planned` hour booked at 0 kWh is governed too: the task booked it on price (or
// needs every hour because it cannot finish), so during an active task it decides
// whether the device runs, also on grid import for a "Run on solar surplus" device
// (owner ruling 2026-09-25: during an active smart task, the task decides).
const resolveAdmittedDeviceIds = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
  devices: readonly PlanInputDevice[],
): ReadonlySet<string> => {
  const surplusFollowers = new Set(devices.filter(followsSurplusWhileWaiting).map((device) => device.id));
  const admitted = new Set<string>();
  for (const [deviceId, decision] of decisions) {
    if (decision.kind === 'planned' || (decision.kind === 'idle'
      && (decision.holdCause === 'battery_discharging' || !surplusFollowers.has(deviceId)))) {
      admitted.add(deviceId);
    }
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
