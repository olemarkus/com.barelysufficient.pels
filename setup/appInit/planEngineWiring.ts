import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { SteppedCommandStore } from '../../lib/executor/steppedCommandStore';
import type { SteppedReportedStepStore } from '../../lib/observer/steppedReportedStep';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { PlanExecutorDeps } from '../../lib/executor/planExecutor';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../lib/logging/logger';
import type { BinaryCommandLifecycleListener } from '../../lib/observer/pendingBinaryCommands';
import type { PlanBuilderDeps } from '../../lib/plan/planBuilder';
import type { PendingTargetObservationSource, ShedBehavior } from '../../lib/plan/planTypes';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { PriceLevel } from '../../lib/price/priceLevels';
import type { PowerTrackerState } from '../../lib/power/tracker';

/**
 * Setup-owned inputs for composing one planner and executor over shared state.
 * This broad wiring contract must not cross the public `PlanEngine` seam.
 */
export type PlanEngineWiring = {
  getHomeDisplayName: PlanExecutorDeps['getHomeDisplayName'];
  homeId: PlanExecutorDeps['homeId'];
  setCapacityInShortfall: (inShortfall: boolean) => void;
  steppedCommandStore: SteppedCommandStore;
  steppedReportedStore: SteppedReportedStepStore;
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  deviceManager: PlanExecutorDeps['deviceManager'];
  // Named for what the executor needs — the observed RECORD, because its drift
  // check reads the reported step, measured power and EV state off it — rather
  // than reusing the app's base-state read, which is assignable here and would
  // work only while the object stayed physically wider than its type.
  getObservedRecord: PlanExecutorDeps['getObservedState'];
  getObservationRevision: PlanExecutorDeps['getObservationRevision'];
  actuator: Actuator;
  binaryCommandLifecycle?: BinaryCommandLifecycleListener;
  capacityGuard: CapacityGuard;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getModeDeviceTargets: () => Record<string, Record<string, number>>;
  getPriceOptimizationEnabled: () => boolean;
  getPriceOptimizationSettings: () => Record<string, {
    enabled: boolean;
    cheapDelta: number;
    expensiveDelta: number;
  }>;
  getCurrentHourPriceLevel: () => PriceLevel;
  getInferredSurplusKw: () => number;
  /**
   * "Leave off until turned on again", resolved once for every home in
   * `createPlanEngine`. Required: a home wired without it would silently make
   * the executor's restore carve-out a no-op for that home's devices.
   */
  isExternalOffHeld: (deviceId: string) => boolean;
  /** Pre-shed setpoint anchor store — the persisted adapter, shared across
   * homes (device ids are globally unique). Required: a home wired without it
   * would silently lose anchors across restarts. */
  getPowerTracker: () => PowerTrackerState;
  /** Scope-owned; a capacity-only home binds the constant `null`, not an absent member. */
  getDailyBudgetSnapshot: () => DailyBudgetUiPayload | null;
  /**
   * Scope-owned smart-task seam. Every home has an answer here, and a
   * capacity-only one binds `decorateWithoutDeferredObjectives`.
   */
  decorateDeferredObjectives: PlanBuilderDeps['decorateDeferredObjectives'];
  getShedBehavior: (deviceId: string) => ShedBehavior;
  /** Scope-owned; a capacity-only home binds the constant `null`, not an absent member. */
  getDynamicSoftLimitOverride: () => number | null;
  logTargetRetryComparison?: (params: {
    deviceId: string;
    name: string;
    target: 'temperature';
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }) => Promise<void> | void;
  /** Scope-owned, so the sync targets THIS home's plan service. Every home binds one. */
  syncLivePlanStateAfterTargetActuation: (source: PendingTargetObservationSource) => boolean | void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    confirmationPolicy?: 'required' | 'assume_applied';
    /** See `MarkSteppedLoadDesiredStepIssuedParams`: no probe on an unanswered write. */
    unacknowledged?: boolean;
  }) => void;
  getSteppedLoadCommandSession: (deviceId: string) => {
    initializationAssumedStepId?: string;
    hasPriorStepCommand: boolean;
    reportedStepId?: string;
    stepCommandPending: boolean;
  };
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
