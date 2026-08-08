import type { PowerTrackerState } from '../../power/tracker';
import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { BuildPriceHorizon } from './diagnosticsBridge';
import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ObjectiveDeviceInput } from '../types';
import type { StructuredDebugEmitter } from '../../logging/logger';
import {
  buildDeferredObjectiveDiagnostics,
  emitDeferredObjectiveDiagnostics,
  type DeferredObjectiveDiagnostic,
} from './diagnosticsBridge';
import { emitDeferredObjectiveStatusTransitions } from './statusTransitions';
import type { DeferredObjectiveStatusBus } from './statusBus';
import type { DeferredObjectiveHoursRemainingBus } from './hoursRemainingBus';
import type { DeferredObjectiveHoursRemainingTracker } from './hoursRemainingCrossings';
import type { DeferredObjectiveSettingsV1 } from './settings';
import type { IdleClassification } from '../../../packages/shared-domain/src/idleClassificationCopy';
import { PriorityAllocationTracker } from './priorityAllocation';

type StallClassification = IdleClassification | undefined;

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
 * own evaluation snapshot; only this side feeds the UI and persisted records.
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
  // Price-layer allocation-horizon producer, injected by the wiring layer. The
  // daily-budget snapshot is now only the budget overlay.
  buildPriceHorizon: BuildPriceHorizon;
  getPriceOptimizationEnabled: () => boolean;
  getDeferredObjectiveActivePlans: () => DeferredObjectiveActivePlansV1 | null;
  getHardCapKw: () => number | null;
  /** Live priority from the user's current saved mode; runtime order is derived on read. */
  getBasePriorityForDevice: (deviceId: string) => unknown;
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
  /**
   * Active-plan commitment RECORD. Settles replan revisions on the clock — the
   * recorder gates them to once per hour at the `:58` mark (a first revision is
   * immediate). The planner READS the committed plan every power cycle (via
   * `resolveCommittedHours`) for its decoration; only the WRITE rides the clock,
   * so it can never be starved by power-reading timing. See
   * `notes/state-management/deferred-objective-lifecycle-carveout.md`.
   */
  observeDeferredObjectiveActivePlans?: (
    diagnostics: DeferredObjectiveDiagnostic[],
    nowMs: number,
  ) => void;
  getStallClassification?: (deviceId: string) => StallClassification;
  // Multi-home v1 scope predicate (wiring-injected): `true` marks a task's
  // device as belonging to a separate-meter sub-home, so THIS lane's
  // diagnostics — the sole writers of plan-history/active-plan records and the
  // drivers of the status buses — resolve to the dedicated
  // `objective_device_in_sub_home` unknown code, and the concurrent-eligible
  // denominator excludes the task (a relocated reserved task must not shrink
  // main tasks' shares). Optional: absent (tests) or with no sub-homes
  // configured, behavior is identical.
  isDeviceInSubHome?: (deviceId: string) => boolean;
};

export class DeferredObjectiveLifecycleEmitter {
  private readonly priorityAllocationTracker = new PriorityAllocationTracker();

  constructor(private readonly deps: DeferredObjectiveLifecycleEmitterDeps) {}

  /** Evaluate the lifecycle at `nowMs` and emit/observe its facts. Pure side-effects. */
  tick(nowMs: number): void {
    const settings = this.deps.getDeferredObjectiveSettings();
    if (!settings) return;

    // Read the active-plan recorder snapshot ONCE per tick and reuse it for the
    // diagnostics build and the plan-history observe. NOTE: the active-plan WRITE
    // below mutates the recorder later in this same tick, so the snapshot
    // forwarded to plan-history is the PRE-write state — plan-history correlates
    // against the previous tick's commitment (a ≤30 s lag, immaterial for the
    // history record). The read itself is in-memory (no SDK call).
    const activePlans = this.deps.getDeferredObjectiveActivePlans();

    const diagnostics = buildDeferredObjectiveDiagnostics({
      nowMs,
      timeZone: this.deps.getTimeZone(),
      devices: this.deps.getDevices(),
      settings,
      powerTracker: this.deps.getPowerTracker(),
      dailyBudgetSnapshot: this.deps.getDailyBudgetSnapshot(),
      buildPriceHorizon: this.deps.buildPriceHorizon,
      priceOptimizationEnabled: this.deps.getPriceOptimizationEnabled(),
      activePlans,
      hardCapKw: this.deps.getHardCapKw(),
      priorityAllocationTracker: this.priorityAllocationTracker,
      getBasePriorityForDevice: this.deps.getBasePriorityForDevice,
      isDeviceInSubHome: this.deps.isDeviceInSubHome,
      // Resolve the user-facing status to `satisfied` for parked/stalled devices
      // so the status chip, notifications, Flows (active-plan recorder) and the
      // postmortem all agree. The decoration/actuation path builds its own
      // diagnostics WITHOUT this, keeping admission on the raw trajectory status.
      getStallClassification: this.deps.getStallClassification,
    });

    // Plan-history record, using this tick's (pre-write) snapshot.
    this.deps.observeDeferredObjectivePlanHistory?.(
      diagnostics,
      nowMs,
      activePlans,
      this.deps.getStallClassification,
    );

    // Active-plan commitment WRITE, on the clock. The recorder gates replan
    // revisions to once per hour at the :58 mark (a first revision is immediate).
    // The planner only READS the committed plan (resolveCommittedHours) every
    // power cycle for its decoration, so the write need not be synchronous with
    // planning — driving it off the reliable 30 s clock means it can never be
    // starved by power-reading timing. Written after the plan-history observe
    // above, which intentionally uses the pre-write snapshot (see note above).
    // See notes/state-management/deferred-objective-lifecycle-carveout.md.
    this.deps.observeDeferredObjectiveActivePlans?.(diagnostics, nowMs);

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
