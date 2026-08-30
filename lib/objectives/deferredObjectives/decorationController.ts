import { resolvedTrajectoryStatus } from './diagnosticTypes';
import type { ResolveObjectiveDeviceExclusion } from './deviceExclusion';
import type { PowerTrackerState } from '../../power/tracker';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { BuildPriceHorizon } from './diagnosticsBridge';
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
  type DeferredAdmissionDecision,
} from './admission';
import { buildDeferredObjectiveDiagnostics } from './diagnosticsBridge';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectiveSettingsV1 } from './settings';
import { PriorityAllocationTracker } from './priorityAllocation';

export type DeferredObjectiveDecorationControllerDeps = {
  getDeferredObjectiveSettings?: () => DeferredObjectiveSettingsV1 | undefined;
  getDeferredObjectiveActivePlans?: () => DeferredObjectiveActivePlansV1 | null;
  getTimeZone?: () => string;
  getPowerTracker: () => PowerTrackerState;
  getPriceOptimizationEnabled: () => boolean;
  getHardCapKw: () => number;
  /** Live priority from the user's current saved mode; runtime order is derived on read. */
  getBasePriorityForDevice?: (deviceId: string) => unknown;
  // Price-layer allocation-horizon producer, injected by the wiring layer. The
  // daily-budget snapshot (threaded via `decorate(input)`) is now only the
  // budget overlay.
  buildPriceHorizon: BuildPriceHorizon;
  // Durable device-exclusion resolver (wiring-injected): names why the task's
  // device is out of the main planning lane — a separate-meter sub-home, or the
  // owner turning "Managed by PELS" off. The diagnostic resolves to that
  // exclusion's dedicated unknown code and the task never governs the device.
  // Optional — absent (tests), or answering `null`, behavior is identical.
  resolveDeviceExclusion?: ResolveObjectiveDeviceExclusion;
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
 * price-optimization flag, hard cap, time zone, settings, active plans) so the
 * planner does not thread smart-task concerns through its own dependency surface.
 */
export class DeferredObjectiveDecorationController {
  private readonly priorityAllocationTracker = new PriorityAllocationTracker();

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
    const targetOverrides = buildDeferredTargetOverrides(evaluations);
    const admission = applyDeferredAdmissionToInput(devices, decisions, targetOverrides);
    return {
      admittedDevices: admission.devices,
      forceShedSet: admission.forceShedSet,
      deferredAvoidDeviceIds: resolveDeferredAvoidDeviceIds(evaluations),
      deferredReleaseIntentByDeviceId: buildDeferredReleaseIntents(decisions),
      admittedDeviceIds: resolveAdmittedDeviceIds(decisions),
    };
  }

  private evaluate(
    devices: DeferredDecorationInput['devices'],
    dailyBudgetSnapshot: DailyBudgetUiPayload | null,
    nowTs: number,
  ): DeferredObjectiveDiagnostic[] {
    // Mirrors the planner's `trackPlanStage` (duration + per-op RSS delta) so the
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
        buildPriceHorizon: this.deps.buildPriceHorizon,
        priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
        activePlans: this.deps.getDeferredObjectiveActivePlans?.() ?? null,
        hardCapKw: this.deps.getHardCapKw(),
        priorityAllocationTracker: this.priorityAllocationTracker,
        getBasePriorityForDevice: this.deps.getBasePriorityForDevice,
        resolveDeviceExclusion: this.deps.resolveDeviceExclusion,
      });
    } finally {
      addPerfDuration('evaluate_deferred_objectives_ms', Date.now() - start);
      recordOpRssDelta('evaluate_deferred_objectives_ms', rssBefore, safeRss());
    }
  }
}

// Devices whose deferred objective is currently GOVERNING them: a `planned` or
// `idle` admission decision this cycle. Consumed by the planner as
// `admittedDeviceIds` — its only consumer is the surplus dump-load hold
// (`planBuilderSurplus` → `shedding/surplusHold`), which a governed device is
// exempt from.
//
// `inactive` (task disabled, satisfied, or otherwise not plannable) is excluded so
// a finished smart task cannot keep a device out of the hold forever.
//
// `unclaimed` is excluded too, and that is a decision rather than an inheritance.
// The task is explicitly NOT claiming this hour, so it is not governing the device
// during it — and the whole point of the state is that the device falls back to how
// it would behave anyway. For a device the user put on "Run on solar surplus", how
// it behaves anyway is: wait for surplus. Admitting it here would instead let the
// ordinary restore lane start it on GRID import in exactly the hour the budget
// forecast zeroed, which is usually the dearest one — defeating the feature the
// user turned on, and doing so silently.
const resolveAdmittedDeviceIds = (
  decisions: ReadonlyMap<string, DeferredAdmissionDecision>,
): ReadonlySet<string> => {
  const admitted = new Set<string>();
  for (const [deviceId, decision] of decisions) {
    if (decision.kind === 'planned' || decision.kind === 'idle') admitted.add(deviceId);
  }
  return admitted;
};

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
    // Price-deferral / cold-start release: the device is idled this cycle because
    // either it is already at/above this hour's trajectory milestone and a later
    // hour is cheaper (`priceDeferralEligible`), or a later hour is meaningfully
    // cheaper and the current hour's catch-up fits there at its real step
    // (`coldStartReleaseEligible`). Both get the "waiting for cheaper hours"
    // framing — even though the current bucket carries booked energy and the plan
    // status may be `at_risk`. Without this the reason falls through to
    // capacity/daily-budget framing and the pause is miscounted as starvation.
    if (diag.horizonPlan?.priceDeferralEligible || diag.horizonPlan?.coldStartReleaseEligible) {
      avoidIds.add(diag.deviceId);
      continue;
    }
    if (resolvedTrajectoryStatus(diag) !== 'on_track') continue;
    // Read the producer's claim rather than re-deriving "is the current hour
    // unbooked" from the bucket. An `unclaimed` hour is one the task could not book
    // but still needs, so the device is NOT waiting for anything cheaper — labelling
    // it so would state the opposite of the admission decision, and (per the comment
    // above) would also drop a genuinely starved device out of starvation counting.
    if (diag.horizonPlan?.currentHourClaim === 'released') avoidIds.add(diag.deviceId);
  }
  return avoidIds;
};
