import type { PowerTrackerState } from '../../power/tracker';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import {
  buildDeferredObjectiveDiagnostics,
  emitDeferredObjectiveDiagnostics,
  type DeferredObjectiveDiagnostic,
} from './diagnosticsBridge';
import { ConcurrentEligibleTaskTracker } from './concurrentEligibleTasks';
import { emitDeferredObjectiveStatusTransitions } from './statusTransitions';
import type { DeferredObjectiveStatusBus } from './statusBus';
import type { DeferredObjectiveHoursRemainingBus } from './hoursRemainingBus';
import type { DeferredObjectiveHoursRemainingTracker } from './hoursRemainingCrossings';
import type { DeferredObjectiveSettingsV1 } from './settings';

type StallClassification = 'near_target_idle' | 'unresponsive' | 'capped_idle' | undefined;

/**
 * Clock-driven smart-task lifecycle emission.
 *
 * This is the EMISSION half of the deferred-objective (smart-task) lifecycle —
 * the time-based facts that feed the UI and Flow cards (status transitions,
 * hours-remaining crossings, ended/deadline-passed events) and the
 * plan-history/active-plan recorders. None of it is consumed by the planner.
 *
 * It used to run inside `planBuilder` on the power-driven plan cycle, so in
 * `power_source = flow` mode (where plan cycles can be hours apart) deadline /
 * ended / hours-remaining transitions lagged until the next power event. This
 * emitter runs the same evaluation on the smart-task **clock** instead
 * (`startDeferredObjectiveLifecycleClock`), so the lifecycle advances on time.
 *
 * The planner still computes its own evaluation per plan cycle for the
 * *decoration* (admission / target overrides) it applies to `PlanInputDevice`s
 * — that stays synchronous with planning. This emitter therefore owns its own
 * `ConcurrentEligibleTaskTracker`: the cross-cycle grace-window smoothing is
 * per-evaluator. The emitter's count and the planner's decoration count can
 * differ transiently during an SDK snapshot flicker; both self-heal within the
 * grace window, and only this side feeds the UI.
 *
 * See notes/state-management/deferred-objective-lifecycle-carveout.md.
 */
export type DeferredObjectiveLifecycleEmitterDeps = {
  getDeferredObjectiveSettings: () => DeferredObjectiveSettingsV1 | undefined;
  getTimeZone: () => string;
  /** Live device inputs (the same source the plan loop reads via getPlanDevices). */
  getDevices: () => ObjectiveDeviceInput[];
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot: () => DailyBudgetUiPayload | null;
  getPriceOptimizationEnabled: () => boolean;
  getDeferredObjectiveActivePlans: () => DeferredObjectiveActivePlansV1 | null;
  getHardCapKw: () => number | null;
  getDeferredObjectiveDebugStructured?: () => StructuredDebugEmitter | undefined;
  getDeferredObjectiveStatusBus?: () => DeferredObjectiveStatusBus | undefined;
  getDeferredObjectiveHoursRemainingBus?: () => DeferredObjectiveHoursRemainingBus | undefined;
  getDeferredObjectiveHoursRemainingTracker?: () => DeferredObjectiveHoursRemainingTracker | undefined;
  /**
   * Fired once a task's deadline has passed. App-wired (the emitter cannot import
   * `lib/device`/`lib/executor`), it owns BOTH ends of "ending" a task: it returns
   * the cap-off device the task was driving to its configured fallback posture
   * directly via the transport (closing the `power_source = flow` gap where the
   * next plan cycle — which used to emit the terminal `shed_release` — can be
   * hours away), AND it disarms the task. The disarm is gated on the release being
   * settled (device observed in the shed posture) or a grace window, so the
   * diagnostic survives across ticks and the release re-fires until the device
   * confirms off — never a single shot a transient `unknown` observation can miss.
   */
  onDeadlineReached?: (
    deviceId: string,
    objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
    deadlineAtMs: number,
    nowMs: number,
  ) => void;
  observeDeferredObjectivePlanHistory?: (
    diagnostics: DeferredObjectiveDiagnostic[],
    nowMs: number,
    activePlans: DeferredObjectiveActivePlansV1 | null,
    getStallClassification?: (deviceId: string) => StallClassification,
  ) => void;
  getStallClassification?: (deviceId: string) => StallClassification;
};

export class DeferredObjectiveLifecycleEmitter {
  private readonly concurrentEligibleTracker = new ConcurrentEligibleTaskTracker();

  constructor(private readonly deps: DeferredObjectiveLifecycleEmitterDeps) {}

  /** Evaluate the lifecycle at `nowMs` and emit/observe its facts. Pure side-effects. */
  tick(nowMs: number): void {
    const settings = this.deps.getDeferredObjectiveSettings();
    if (!settings) return;

    // Read the active-plan recorder snapshot ONCE per tick and reuse it for both
    // the diagnostics build and the plan-history observe callback. The snapshot is
    // an in-memory recorder read (no SDK call) and nothing mutates the recorder
    // within this synchronous tick, so the single read is behavior-identical.
    const activePlans = this.deps.getDeferredObjectiveActivePlans();

    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs,
      timeZone: this.deps.getTimeZone(),
      devices: this.deps.getDevices(),
      settings,
      powerTracker: this.deps.getPowerTracker(),
      dailyBudgetSnapshot: this.deps.getDailyBudgetSnapshot(),
      priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
      activePlans,
      hardCapKw: this.deps.getHardCapKw(),
      concurrentEligibleTracker: this.concurrentEligibleTracker,
    });

    // Plan-history recording is pure lifecycle/UI state (the planner does not
    // read it), so it rides the clock. Active-plan COMMITMENT stays on the plan
    // cycle in planBuilder — the planner reads committed plans via
    // resolveCommittedHours for its decoration, so that promotion must stay
    // synchronous with planning, not lag up to a clock tick.
    this.deps.observeDeferredObjectivePlanHistory?.(
      diagnostics,
      nowMs,
      activePlans,
      this.deps.getStallClassification,
    );

    // Emission to the UI / Flow buses + deadline-passed disable.
    const debugStructured = this.deps.getDeferredObjectiveDebugStructured?.();
    if (debugStructured) {
      emitDeferredObjectiveDiagnostics({ diagnostics, debugStructured });
    }
    const statusBus = this.deps.getDeferredObjectiveStatusBus?.();
    if (statusBus) {
      emitDeferredObjectiveStatusTransitions({
        diagnostics,
        statusBus,
        nowMs,
        onDeadlineReached: this.deps.onDeadlineReached,
      });
    }
    const hoursRemainingBus = this.deps.getDeferredObjectiveHoursRemainingBus?.();
    const hoursRemainingTracker = this.deps.getDeferredObjectiveHoursRemainingTracker?.();
    if (hoursRemainingBus && hoursRemainingTracker) {
      hoursRemainingTracker.observe({ diagnostics, nowMs, bus: hoursRemainingBus });
    }
  }
}
