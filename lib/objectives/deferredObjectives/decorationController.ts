import type { PowerTrackerState } from '../../power/tracker';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredDecorationBundle,
  DeferredDecorationInput,
} from '../../../packages/planner-types/src/deferredDecoration';
import { addPerfDuration } from '../../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../../utils/opRssTracker';
import {
  applyDeferredAdmissionToInput,
  applyDeferredObjectiveAdmission,
  buildDeferredReleaseIntents,
  buildDeferredTargetOverrides,
} from './admission';
import { ConcurrentEligibleTaskTracker } from './concurrentEligibleTasks';
import { buildDeferredObjectiveDiagnostics } from './diagnosticsBridge';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectiveSettingsV1 } from './settings';

export type DeferredObjectiveDecorationControllerDeps = {
  getDeferredObjectiveSettings?: () => DeferredObjectiveSettingsV1;
  getDeferredObjectiveActivePlans?: () => DeferredObjectiveActivePlansV1 | null;
  getTimeZone?: () => string;
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  getHardCapKw: () => number;
  getLearnedThermostatDeadbandC?: (deviceId: string) => number;
};

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
 * Construction-time getters supply the live household context (power tracker,
 * price-optimization flag, hard cap, time zone, settings, active plans, learned
 * deadband) so the planner does not thread smart-task concerns through its own
 * dependency surface.
 */
export class DeferredObjectiveDecorationController {
  // Stateful tracker for the priority-1 fully-reserved smart-task count. Held
  // on the controller so its grace-window state (devices observed within the
  // last `ELIGIBILITY_ABANDON_GRACE_MS`) survives across plan cycles — without
  // that, a transient SDK-side device-snapshot eviction flickers the count down
  // for one cycle and survivor diagnostics oscillate `on_track` ↔
  // `at_risk: feasible_above_floor`. Not persisted across PELS restarts; on
  // restart the first cycle rebuilds the map, accepting one potential flicker
  // window in exchange for keeping the eligibility model off the settings
  // contract.
  private readonly concurrentEligibleTracker = new ConcurrentEligibleTaskTracker();

  constructor(private readonly deps: DeferredObjectiveDecorationControllerDeps) {}

  public decorate(input: DeferredDecorationInput): DeferredDecorationBundle {
    const { devices, dailyBudgetSnapshot, nowTs } = input;
    const evaluations = this.evaluate(devices, dailyBudgetSnapshot, nowTs);
    // The active-plan RECORD (revisions) is written on the lifecycle clock
    // (`DeferredObjectiveLifecycleEmitter`), not here. This stage only READS the
    // committed plan (via the diagnostics build above, which consults
    // `resolveCommittedHours`) to decorate the device inputs — reading is free
    // every cycle; only the write rides the clock. See the carve-out note.
    const decisions = applyDeferredObjectiveAdmission(evaluations, devices);
    const targetOverrides = buildDeferredTargetOverrides(
      evaluations,
      this.deps.getLearnedThermostatDeadbandC,
    );
    const admission = applyDeferredAdmissionToInput(devices, decisions, targetOverrides);
    return {
      admittedDevices: admission.devices,
      forceShedSet: admission.forceShedSet,
      deferredAvoidDeviceIds: resolveDeferredAvoidDeviceIds(evaluations),
      deferredReleaseIntentByDeviceId: buildDeferredReleaseIntents(decisions),
    };
  }

  private evaluate(
    devices: DeferredDecorationInput['devices'],
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
    nowTs: number,
  ): DeferredObjectiveDiagnostic[] {
    // Mirrors the planner's `trackDuration` (duration + per-op RSS delta) so the
    // `evaluate_deferred_objectives_ms` telemetry is unchanged by the relocation;
    // per-op RSS attribution matters under PELS's tight memory ceiling.
    const start = Date.now();
    const rssBefore = safeRss();
    try {
      const settings = this.deps.getDeferredObjectiveSettings?.();
      if (!settings) return [];
      return buildDeferredObjectiveDiagnostics({
        nowMs: nowTs,
        timeZone: this.deps.getTimeZone?.() ?? 'UTC',
        devices,
        settings,
        powerTracker: this.deps.getPowerTracker(),
        dailyBudgetSnapshot,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        activePlans: this.deps.getDeferredObjectiveActivePlans?.() ?? null,
        hardCapKw: this.deps.getHardCapKw(),
        concurrentEligibleTracker: this.concurrentEligibleTracker,
      });
    } finally {
      addPerfDuration('evaluate_deferred_objectives_ms', Date.now() - start);
      recordOpRssDelta('evaluate_deferred_objectives_ms', rssBefore, safeRss());
    }
  }
}

// Devices whose smart task is on track AND has no allocated energy this hour
// (the current hour was relatively expensive so the allocator booked the load
// into cheaper hours, or the task is between planned hours). Used downstream by
// `normalizeShedReasons` to render the
// `deferredObjectiveAvoid` reason ("Waiting for cheaper hours") instead of the
// misleading capacity/dailyBudget fallback when the device ends up held.
//
// Gating on `status === 'on_track'` is intentional: the calm "Waiting for
// cheaper hours" framing is honest only while PELS still believes the deadline
// will be met. `at_risk` / `cannot_meet` tasks must fall through to the
// physical-constraint framing so the Overview doesn't mask a failure the user
// already got notified about. `inactive` / `satisfied` / `invalid` never reach
// this branch because they don't co-occur with an unbooked current hour.
export const resolveDeferredAvoidDeviceIds = (
  evaluations: readonly DeferredObjectiveDiagnostic[],
): Set<string> => {
  const avoidIds = new Set<string>();
  for (const diag of evaluations) {
    // Price-deferral release: the device is idled this cycle because it is already
    // at/above this hour's trajectory milestone and a later hour is cheaper, so it
    // gets the "waiting for cheaper hours" framing too — even though the current
    // bucket carries booked energy and the plan status may be `at_risk`. Without
    // this the reason falls through to capacity/daily-budget framing and the pause
    // is miscounted as starvation.
    if (diag.horizonPlan?.priceDeferralEligible) {
      avoidIds.add(diag.deviceId);
      continue;
    }
    if (diag.status !== 'on_track') continue;
    const currentBucket = diag.horizonPlan?.currentBucket;
    const currentHourUnbooked = !currentBucket || currentBucket.plannedUsefulEnergyKWh <= 0;
    if (currentHourUnbooked) avoidIds.add(diag.deviceId);
  }
  return avoidIds;
};
