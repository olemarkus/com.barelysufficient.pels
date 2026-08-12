import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { DeviceDiagnosticsRecorder } from '../../lib/diagnostics/deviceDiagnosticsService';
import type { PlanExecutorDeps } from '../../lib/executor/planExecutor';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../../lib/logging/logger';
import type { BinaryCommandLifecycleListener } from '../../lib/observer/pendingBinaryCommands';
import type { PlanBuilderDeps } from '../../lib/plan/planBuilder';
import type { PendingTargetObservationSource, ShedAction } from '../../lib/plan/planTypes';
import type CapacityGuard from '../../lib/power/capacityGuard';
import type { PowerTrackerState } from '../../lib/power/tracker';

/**
 * Setup-owned inputs for composing one planner and executor over shared state.
 * This broad wiring contract must not cross the public `PlanEngine` seam.
 */
export type PlanEngineWiring = {
  getHomeDisplayName: PlanExecutorDeps['getHomeDisplayName'];
  homeId: PlanExecutorDeps['homeId'];
  setCapacityInShortfall: (inShortfall: boolean) => void;
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  deviceManager: PlanExecutorDeps['deviceManager'];
  getObservedState: PlanExecutorDeps['getObservedState'];
  actuator: Actuator;
  binaryCommandLifecycle?: BinaryCommandLifecycleListener;
  getCapacityGuard: () => CapacityGuard | undefined;
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
  getCurrentHourPriceLevel: () => { cheap: boolean; expensive: boolean };
  getInferredSurplusKw?: () => number | null;
  getObservationStale?: (deviceId: string) => boolean;
  isExternalOffHeld?: (deviceId: string) => boolean;
  getPowerTracker: () => PowerTrackerState;
  getDailyBudgetSnapshot?: () => DailyBudgetUiPayload | null;
  decorateDeferredObjectives?: PlanBuilderDeps['decorateDeferredObjectives'];
  getShedBehavior: (deviceId: string) => {
    action: ShedAction;
    temperature: number | null;
    stepId: string | null;
  };
  getPriorityForDevice: (deviceId: string) => number;
  getDynamicSoftLimitOverride?: () => number | null;
  holdsModeTargetRaisesWhilePowerUnknown?: () => boolean;
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
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
    confirmationPolicy?: 'required' | 'assume_applied';
  }) => void;
  getSteppedLoadCommandSession: (deviceId: string) => {
    initializationAssumedStepId?: string;
    hasPriorStepCommand: boolean;
    reportedStepId?: string;
  };
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
