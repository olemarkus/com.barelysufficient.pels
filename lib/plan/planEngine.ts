/**
 * Per-cycle planning engine: the construction point for the
 * `PlanBuilder` / `PlanExecutor` pair. PlanEngine creates the shared mutable
 * `PlanEngineState` (pending target/binary command maps, headroom-card
 * bookkeeping, overshoot tracking, shed/restore cooldown clocks) and wires
 * both halves over that single instance; its public methods are thin facades
 * that route to the builder (plan assembly, soft limits) or the executor
 * (actuation, shortfall handling) without adding decision logic of their own.
 * `state` is deliberately public: app boot hydrates
 * `state.lastDeviceControlledMs` from settings and `PlanService` stamps
 * `state.currentRebuildReason` around each build.
 *
 * Boundary rules (`lib/plan/AGENTS.md`, enforced by dependency-cruiser): no
 * device-transport details here — Homey reads/writes stay behind the injected
 * deps, and `lib/plan` must not import `lib/device` beyond the producer
 * seams — and no smart-task imports: `lib/objectives` is forbidden; deferred
 * decoration arrives only through the injected `decorateDeferredObjectives`
 * seam. Capacity-model internals: `docs/technical.md`.
 */
import type { HomeyRuntime, FlowPort } from '../ports/homeyRuntime';
import CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DevicePlan, PendingTargetObservationSource, PlanInputDevice, ShedAction } from './planTypes';
import { PlanBuilder, PlanBuilderDeps } from './planBuilder';
import type { PlanActuationMode } from '../executor/executorTypes';
import { PlanExecutor } from '../executor/planExecutor';
import type { PlanActuationResult, PlanExecutorDeps } from '../executor/planExecutor';
import { createPlanEngineState, PlanEngineState } from './planState';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
  type HeadroomCardDeviceLike,
  type HeadroomForDeviceDecision,
  type HeadroomUsageObservation,
} from './planHeadroomDevice';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  decoratePlanWithPendingTargetCommands,
  prunePendingTargetCommandsForPlan,
  syncPendingTargetCommands,
} from './planTargetControl';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
  type PendingBinaryCommandStore,
  type PendingBinaryLiveDevice,
} from '../observer/pendingBinaryCommands';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import { getLogger, type Logger as PinoLogger, type StructuredDebugEmitter } from '../logging/logger';
import type { Actuator } from '../actuator/deviceActuator';

const moduleLogger = getLogger('plan/engine');

/**
 * Engine dependency bag, wired once in `setup/appInit/createPlanEngine.ts`.
 * Getter fields are live closures over `AppContext` — re-read every cycle,
 * so settings changes take effect on the next rebuild without re-wiring.
 */
export type PlanEngineDeps = {
  // --- SDK/runtime port. The only Homey surface the engine sees; the
  // executor uses it solely for the `capacity_shortfall` flow trigger card.
  // Settings persistence goes through the typed writers below, never here.
  homey: HomeyRuntime & { flow: FlowPort };
  // --- Persisted-signal writers (setup wires both to `homey.settings.set`).
  // `setCapacityInShortfall` publishes the shortfall ("panic") flag to the
  // `capacity_in_shortfall` setting; its consumer is the `pels_insights`
  // virtual device, which listens for the settings-change event and flips
  // its shortfall capability. Written on transitions only — by the builder
  // when the guard's shortfall state changes, and by the executor's
  // `handleShortfall`/`handleShortfallCleared`.
  setCapacityInShortfall: (inShortfall: boolean) => void;
  // Persists `state.lastDeviceControlledMs` so app boot
  // (`hydratePlanEngineControlState`) can rehydrate it; the restore lane
  // reads those timestamps to apply the startup-stabilization hold.
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  // --- Executor actuation seams: device transport, observer-owned state
  // reads, and the single intent-shaped write seam. Forwarded to
  // `PlanExecutor` untouched; the builder never sees them.
  deviceManager: PlanExecutorDeps['deviceManager'];
  getObservedState: PlanExecutorDeps['getObservedState'];
  actuator: Actuator;
  // --- Capacity/price/budget readers consumed by the builder each cycle.
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
  isCurrentHourCheap: () => boolean;
  isCurrentHourExpensive: () => boolean;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  // Pre-built smart-task decoration function (the app wiring constructs the
  // DeferredObjectiveDecorationController and passes its `decorate` here). The
  // engine forwards it straight to the builder — lib/plan never imports
  // lib/objectives, so neither the planner nor the executor knows about smart
  // tasks directly.
  decorateDeferredObjectives?: PlanBuilderDeps['decorateDeferredObjectives'];
  // --- Per-device policy lookups (user configuration resolved by the app
  // layer): how a device sheds and where it ranks for shed/restore ordering.
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  getPriorityForDevice: (deviceId: string) => number;
  // Non-null only when the app-level `computeDynamicSoftLimit` has been
  // replaced (test/diagnostic seam). When set, the builder uses it verbatim
  // and clears `hourlyBudgetExhausted` instead of deriving the soft limit
  // from the capacity budget.
  getDynamicSoftLimitOverride?: () => number | null;
  // --- Actuation feedback callbacks: routes from the executor back up into
  // the app/service layer after a write, so the published plan snapshot and
  // retry logging reflect actuation without waiting for a full rebuild.
  // `syncLivePlanStateAfterTargetActuation` is wired to
  // `PlanService.syncLivePlanStateInline`.
  logTargetRetryComparison?: (params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }) => Promise<void> | void;
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  // --- Diagnostics + structured logging. All optional; the engine falls
  // back to the module logger when `structuredLog` is absent.
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  // Records an issued step command in the producer-side runtime state
  // (`steppedLoadDesiredByDeviceId`), which the snapshot projection folds
  // back into `PlanInputDevice` (`stepCommandPending`, `desiredStepId`,
  // retry bookkeeping) — this is how later cycles see the in-flight step
  // command instead of re-issuing it.
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
  }) => void;
  // --- Legacy prose loggers (prose-logging sweep retires these in favour of
  // `structuredLog`/`debugStructured`; do not add new call sites).
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PlanEngine {
  public readonly state: PlanEngineState;
  /**
   * Observer-owned facade over `state.pendingBinaryCommands`. The executor's
   * binary-control dispatcher writes/deletes through this store, and plan-
   * and executor-side read sites consult it via `get`/`peek`; nothing
   * reads or evicts the backing `Record` directly. See
   * `notes/state-management/observer-transport-split.md` (PR #4).
   */
  public readonly pendingBinaryCommandStore: PendingBinaryCommandStore;

  private builder: PlanBuilder;
  private executor: PlanExecutor;
  private readonly deviceDiagnostics?: DeviceDiagnosticsRecorder;
  private readonly debugStructuredFn?: StructuredDebugEmitter;
  private readonly structuredLog: PinoLogger;

  constructor(deps: PlanEngineDeps) {
    this.state = createPlanEngineState();
    this.pendingBinaryCommandStore = createPendingBinaryCommandStore(this.state.pendingBinaryCommands);
    this.deviceDiagnostics = deps.deviceDiagnostics;
    this.debugStructuredFn = deps.debugStructured;
    this.structuredLog = deps.structuredLog ?? moduleLogger;

    const builderDeps: PlanBuilderDeps = {
      setCapacityInShortfall: deps.setCapacityInShortfall,
      getCapacityGuard: deps.getCapacityGuard,
      getCapacitySettings: deps.getCapacitySettings,
      getOperatingMode: deps.getOperatingMode,
      getModeDeviceTargets: deps.getModeDeviceTargets,
      getPriceOptimizationEnabled: deps.getPriceOptimizationEnabled,
      getPriceOptimizationSettings: deps.getPriceOptimizationSettings,
      isCurrentHourCheap: deps.isCurrentHourCheap,
      isCurrentHourExpensive: deps.isCurrentHourExpensive,
      getPowerTracker: deps.getPowerTracker,
      getDailyBudgetSnapshot: deps.getDailyBudgetSnapshot,
      getPriorityForDevice: deps.getPriorityForDevice,
      getShedBehavior: deps.getShedBehavior,
      getDynamicSoftLimitOverride: deps.getDynamicSoftLimitOverride,
      deviceDiagnostics: deps.deviceDiagnostics,
      structuredLog: deps.structuredLog,
      debugStructured: deps.debugStructured,
      decorateDeferredObjectives: deps.decorateDeferredObjectives,
      pendingBinaryCommandStore: this.pendingBinaryCommandStore,
      log: deps.log,
      logDebug: deps.logDebug,
    };

    const executorDeps: PlanExecutorDeps = {
      homey: deps.homey,
      setCapacityInShortfall: deps.setCapacityInShortfall,
      persistLastControlledMs: deps.persistLastControlledMs,
      deviceManager: deps.deviceManager,
      getObservedState: deps.getObservedState,
      actuator: deps.actuator,
      getCapacityGuard: deps.getCapacityGuard,
      getCapacitySettings: deps.getCapacitySettings,
      getCapacityDryRun: deps.getCapacityDryRun,
      getOperatingMode: deps.getOperatingMode,
      getShedBehavior: deps.getShedBehavior,
      markSteppedLoadDesiredStepIssued: deps.markSteppedLoadDesiredStepIssued,
      logTargetRetryComparison: deps.logTargetRetryComparison,
      syncLivePlanStateAfterTargetActuation: deps.syncLivePlanStateAfterTargetActuation,
      deviceDiagnostics: deps.deviceDiagnostics,
      pendingBinaryCommandStore: this.pendingBinaryCommandStore,
    };

    this.builder = new PlanBuilder(builderDeps, this.state);
    this.executor = new PlanExecutor(executorDeps, this.state);
  }

  public async buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.builder.buildDevicePlanSnapshot(devices);
  }

  public computeDynamicSoftLimit(): number {
    return this.builder.computeDynamicSoftLimit();
  }

  public computeShortfallThreshold(): number {
    return this.builder.computeShortfallThreshold();
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    return this.executor.handleShortfall(deficitKw);
  }

  public async handleShortfallCleared(): Promise<void> {
    return this.executor.handleShortfallCleared();
  }

  public async applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<PlanActuationResult> {
    return this.executor.applyPlanActions(plan, mode);
  }

  public shouldApplyStablePlanActions(plan: DevicePlan): boolean {
    return this.executor.hasStablePlanActuation(plan);
  }

  public syncPendingTargetCommands(
    devices: PlanInputDevice[],
    source: PendingTargetObservationSource,
  ): boolean {
    return syncPendingTargetCommands({
      state: this.state,
      liveDevices: devices,
      source,
      structuredInfo: (payload) => this.structuredLog.info(payload),
      debugStructured: this.debugStructuredFn,
    });
  }

  public prunePendingTargetCommands(plan: DevicePlan): boolean {
    return prunePendingTargetCommandsForPlan({
      state: this.state,
      plan,
      debugStructured: this.debugStructuredFn,
    });
  }

  public syncPendingBinaryCommands(
    devices: PendingBinaryLiveDevice[],
    source: PendingTargetObservationSource,
  ): boolean {
    return syncPendingBinaryCommands({
      store: this.pendingBinaryCommandStore,
      liveDevices: devices,
      source,
      onConfirmed: ({ deviceId, liveDevice, pending, confirmedAtMs }) => {
        this.executor.handleConfirmedBinaryCommand({
          deviceId,
          liveDevice,
          pending,
          confirmedAtMs,
        });
      },
    });
  }

  public decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return decoratePlanWithPendingTargetCommands(this.state, plan);
  }

  public hasPendingTargetCommands(): boolean {
    return Object.keys(this.state.pendingTargetCommands).length > 0;
  }

  public hasPendingTargetCommandsOlderThan(thresholdMs: number): boolean {
    const nowMs = Date.now();
    return Object.values(this.state.pendingTargetCommands)
      .some((pending) => (nowMs - pending.startedMs) >= thresholdMs);
  }

  public hasPendingBinaryCommands(): boolean {
    return this.pendingBinaryCommandStore.hasAny();
  }

  public getPendingBinaryCommandForDevice(
    deviceId: string,
    communicationModel?: 'local' | 'cloud',
  ): { desired: boolean } | null {
    const pending = this.pendingBinaryCommandStore.peek(deviceId);
    if (!pending || !isPendingBinaryCommandActive({ pending, communicationModel })) return null;
    return { desired: pending.desired };
  }

  public evaluateHeadroomForDevice(params: {
    devices: HeadroomCardDeviceLike[];
    deviceId: string;
    device?: HeadroomCardDeviceLike;
    headroom: number;
    requiredKw: number;
    cleanupMissingDevices?: boolean;
  }): HeadroomForDeviceDecision | null {
    return evaluateHeadroomForDevice({
      state: this.state,
      devices: params.devices,
      deviceId: params.deviceId,
      device: params.device,
      headroom: params.headroom,
      requiredKw: params.requiredKw,
      cleanupMissingDevices: params.cleanupMissingDevices,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public syncHeadroomCardState(params: {
    devices: HeadroomCardDeviceLike[];
    cleanupMissingDevices?: boolean;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return syncHeadroomCardState({
      state: this.state,
      devices: params.devices,
      cleanupMissingDevices: params.cleanupMissingDevices,
      reconciliationContext: params.reconciliationContext,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public syncHeadroomUsageObservation(params: {
    deviceId: string;
    usageObservation: HeadroomUsageObservation;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return syncHeadroomUsageObservation({
      state: this.state,
      deviceId: params.deviceId,
      usageObservation: params.usageObservation,
      reconciliationContext: params.reconciliationContext,
      diagnostics: this.deviceDiagnostics,
    });
  }

  public async applySheddingToDevice(deviceId: string, deviceName: string, reason?: string): Promise<boolean> {
    return this.executor.applySheddingToDevice(deviceId, deviceName, reason);
  }

  public beginStartupRestoreStabilization(durationMs = 60_000, nowTs = Date.now()): void {
    this.state.startupRestoreBlockedUntilMs = nowTs + Math.max(0, durationMs);
  }

  public clearStartupRestoreStabilization(nowTs = Date.now()): boolean {
    if (this.state.startupRestoreBlockedUntilMs === null) return false;
    this.state.startupRestoreBlockedUntilMs = nowTs - 1;
    return true;
  }
}
