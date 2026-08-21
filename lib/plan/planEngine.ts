/**
 * Narrow behavior exposed by the setup-composed planning runtime. Construction,
 * shared mutable state binding, and executor materialization belong in `setup/`;
 * planner consumers cannot construct or subclass this contract.
 */
import type { PlanActuationResult } from '../planContract/planActuationResult';
import type {
  PendingBinaryCommandStore,
  PendingBinaryLiveDevice,
} from '../observer/pendingBinaryCommands';
import type {
  HeadroomCardDeviceLike,
  HeadroomForDeviceDecision,
  HeadroomUsageObservation,
} from './planHeadroomDevice';
import type { PlanEngineState } from './planState';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanInputDevice,
} from './planTypes';

export type PlanEngine = {
  readonly state: PlanEngineState;
  readonly pendingBinaryCommandStore: PendingBinaryCommandStore;
  buildDevicePlanSnapshot: (devices: PlanInputDevice[]) => Promise<DevicePlan>;
  computeDynamicSoftLimit: () => number;
  computeShortfallThreshold: () => number;
  handleShortfall: (deficitKw: number) => Promise<void>;
  handleShortfallCleared: () => Promise<void>;
  applyPlanActions: (plan: DevicePlan) => Promise<PlanActuationResult>;
  shouldApplyStablePlanActions: (plan: DevicePlan) => boolean;
  hasSettledActuation: (basePlan: DevicePlan, livePlan: DevicePlan) => boolean;
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
  decoratePlanWithPendingTargetCommands: (plan: DevicePlan) => DevicePlan;
  hasPendingTargetCommands: () => boolean;
  hasPendingTargetCommandsOlderThan: (thresholdMs: number) => boolean;
  hasPendingBinaryCommands: () => boolean;
  getPendingBinaryCommandForDevice: (deviceId: string) => { desired: boolean } | null;
  hasAttributablePendingBinaryCommand: (deviceId: string) => boolean;
  clearRecentBinaryOffCommand: (deviceId: string, observedOnAtMs?: number) => void;
  evaluateHeadroomForDevice: (params: {
    devices: HeadroomCardDeviceLike[];
    deviceId: string;
    device?: HeadroomCardDeviceLike;
    headroom: number;
    requiredKw: number;
    cleanupMissingDevices?: boolean;
  }) => HeadroomForDeviceDecision | null;
  syncHeadroomCardState: (params: {
    devices: HeadroomCardDeviceLike[];
    cleanupMissingDevices?: boolean;
    reconciliationContext?: 'snapshot_refresh';
  }) => boolean;
  syncHeadroomUsageObservation: (params: {
    deviceId: string;
    usageObservation: HeadroomUsageObservation;
    reconciliationContext?: 'snapshot_refresh';
  }) => boolean;
  applySheddingToDevice: (deviceId: string, deviceName: string, reason?: string) => Promise<boolean>;
  beginStartupRestoreStabilization: (durationMs?: number, nowTs?: number) => void;
  clearStartupRestoreStabilization: (nowTs?: number) => boolean;
};
