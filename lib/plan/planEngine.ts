/**
 * Narrow behavior exposed by the setup-composed planning runtime. Construction
 * and shared mutable state binding belong in `setup/`; planner consumers cannot
 * construct or subclass this contract. The executor-facing methods take the
 * `ExecutionPlan` the planner projected (`buildExecutionPlan`), which the
 * composition passes through unchanged.
 */
import type { PlanActuationResult } from '../planContract/planActuationResult';
import type { SteppedSettleDevice } from '../observer/steppedSettleSnapshot';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { PendingBinaryLiveDevice } from '../ports/controlCommandConfirmation';
import type {
  HeadroomCardDeviceLike,
  HeadroomCardQuery,
  HeadroomForDeviceDecision,
} from './planHeadroomDevice';
import type { PlanEngineState } from './planState';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanInputDevice,
} from './planTypes';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { ExecutionPlan } from '../planContract/executionPlan';

export type PlanEngine = {
  getDeviceExecutionStates: (plan: ExecutionPlan) => ReadonlyMap<string, DeviceExecutionState>;
  readonly state: PlanEngineState;
  readonly pendingBinaryCommandStore: PendingBinaryCommandStore;
  buildDevicePlanSnapshot: (devices: PlanInputDevice[]) => Promise<DevicePlan>;
  computePhysicalPowerLimit: () => number | null;
  computeCapacityPace: () => number | null;
  computeShortfallThreshold: () => number | null;
  handleShortfall: (deficitKw: number) => Promise<void>;
  handleShortfallCleared: () => Promise<void>;
  applyPlanActions: (plan: ExecutionPlan) => Promise<PlanActuationResult>;
  isInverterReleaseRecoveryReady: () => boolean;
  getPendingInverterReleaseCount: (plan: ExecutionPlan) => number;
  shouldApplyStablePlanActions: (plan: ExecutionPlan) => boolean;
  /**
   * Does the executor still have work to do against this plan?
   *
   * Takes no device list: the executor reads the observation from the observer
   * and the in-flight command state from its own stores. What it DOES take is
   * the observation revision the plan was built from, because the answer is only
   * meaningful as of that instant — see `getObservationRevision`.
   */
  hasExecutionWorkOutstanding: (
    plan: ExecutionPlan,
    observationRevisionAtBuild: number,
  ) => boolean;
  /**
   * The observer's accepted-write counter, read before the plan's inputs are
   * captured so the caller can tell whether the observed world moved underneath
   * a build that yielded.
   */
  getObservationRevision: () => number;
  syncPendingTargetCommands: (
    devices: PlanInputDevice[],
    source: PendingTargetObservationSource,
  ) => boolean;
  prunePendingTargetCommands: (plan: DevicePlan) => boolean;
  /**
   * After each build: the executor forgets a command this plan no longer asks
   * for, so a later send of it is a new command rather than a correction
   * (`lib/executor/controlContest.ts`).
   */
  retainContestedCommands: (plan: ExecutionPlan) => void;
  syncPendingBinaryCommands: (
    devices: PendingBinaryLiveDevice[],
    source: PendingTargetObservationSource,
  ) => boolean;
  /** The stepped axis's twin of the above; see `lib/executor/syncSteppedCommands.ts`. */
  syncSteppedCommands: (getDevices: () => readonly SteppedSettleDevice[]) => boolean;
  /**
   * Judge the home-battery setpoints in flight against this reading
   * (`lib/executor/batteryExecutor.ts`), before the build reads their verdicts.
   */
  syncStorageCommands: () => void;
  decoratePlanWithPendingTargetCommands: (plan: DevicePlan) => DevicePlan;
  hasPendingTargetCommands: () => boolean;
  hasPendingTargetCommandsOlderThan: (thresholdMs: number) => boolean;
  hasPendingBinaryCommands: () => boolean;
  hasAttributablePendingBinaryCommand: (deviceId: string) => boolean;
  clearRecentBinaryOffCommand: (deviceId: string, observedOnAtMs?: number) => void;
  evaluateHeadroomForDevice: (query: HeadroomCardQuery) => HeadroomForDeviceDecision;
  /** The snapshot refresh's sync: every device in the refreshed snapshot, and cleanup of the ones that left. */
  syncHeadroomCardState: (devices: HeadroomCardDeviceLike[]) => void;
  syncHeadroomUsageObservation: (deviceId: string, usageKw: number) => void;
  beginStartupRestoreStabilization: (nowMs: number) => void;
  clearStartupRestoreStabilization: (nowTs: number) => boolean;
};
