/**
 * Narrow behavior exposed by the setup-composed planning runtime. Construction,
 * shared mutable state binding, and executor materialization belong in `setup/`;
 * planner consumers cannot construct or subclass this contract.
 */
import type { PlanActuationResult } from '../planContract/planActuationResult';
import type { SteppedSettleDevice } from '../observer/steppedSettleSnapshot';
import type {
  PendingBinaryCommandStore,
  PendingBinaryLiveDevice,
} from '../observer/pendingBinaryCommands';
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

export type PlanEngine = {
  getDeviceExecutionStates: (plan: DevicePlan) => ReadonlyMap<string, DeviceExecutionState>;
  readonly state: PlanEngineState;
  readonly pendingBinaryCommandStore: PendingBinaryCommandStore;
  buildDevicePlanSnapshot: (devices: PlanInputDevice[]) => Promise<DevicePlan>;
  computePhysicalPowerLimit: () => number | null;
  computeCapacityPace: () => number | null;
  computeShortfallThreshold: () => number | null;
  handleShortfall: (deficitKw: number) => Promise<void>;
  handleShortfallCleared: () => Promise<void>;
  applyPlanActions: (plan: DevicePlan) => Promise<PlanActuationResult>;
  shouldApplyStablePlanActions: (plan: DevicePlan) => boolean;
  /**
   * Does the executor still have work to do against this plan?
   *
   * Takes no device list: the executor reads the observation from the observer
   * and the in-flight command state from its own stores. What it DOES take is
   * the observation revision the plan was built from, because the answer is only
   * meaningful as of that instant — see `getObservationRevision`.
   */
  hasExecutionWorkOutstanding: (
    plannedSnapshot: DevicePlan,
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
