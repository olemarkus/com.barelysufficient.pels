import type { PendingTargetObservationSource, ShedBehavior } from '../plan/planTypes';
import type { PendingTargetCommandState, PlanEngineState } from '../plan/planState';
import type { Actuator } from '../actuator/deviceActuator';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { MarkSteppedLoadDesiredStepIssuedParams } from '../ports/steppedCommand';
import type { ExecutorDeviceRead, ObserverDeviceRead } from './executorDeviceRead';
import type { ExecutableSteppedLoadCommandSession } from './executablePlan';
import type { BinaryCommandClaim, BinaryCommandClaimState } from './binaryCommandClaim';
import type { SteppedCommandClaim, SteppedCommandClaimState } from './steppedCommandClaim';
import type {
  TargetCommandClaim,
  TargetCommandClaimState,
  TargetCommandOwner,
} from './targetCommandClaim';

/** Records one actuation against the executor's clocks and diagnostics. */
export type ActuationRecorder = (deviceId: string, name: string, now: number) => void;

/**
 * Where a lane's target write retries are kept: the plan engine's store for the
 * ordinary lane, the lifecycle fallback's own for its lane (plan maintenance
 * never prunes that one).
 */
export type PendingTargetCommandStore = Pick<PlanEngineState, 'pendingTargetCommands' | 'deletePendingTargetCommand'>;

/** The lifecycle fallback lane as the ordinary lane must respect it. */
export type LifecycleFallbackView = {
  /** The lifecycle lane is converging this device; an ordinary write stands down. */
  isActive: (deviceId: string) => boolean;
  /**
   * The target command the lifecycle lane has claimed from the ordinary plan
   * state. A matching ordinary dispatch stands down even after plan
   * maintenance prunes its own pending map.
   */
  getOwnedTargetPending: (deviceId: string) => PendingTargetCommandState | undefined;
};

/**
 * Everything an executor command reads or writes, built once by `PlanExecutor`.
 *
 * `owner` names the lane issuing the command. The ordinary lane carries the
 * plan; the lifecycle fallback lane spreads this context with `owner:
 * 'lifecycle'`, its own target retry store, its authority check and its
 * claim-release retries. The claims are shared by both lanes, which is what
 * serializes their writes.
 *
 * It is also the binary decision's transport (`BinaryControlTransport`): the
 * observer read, the pending store, the actuator and the authority check.
 */
export type ExecutorCommandContext = {
  owner: TargetCommandOwner;
  /** Engine state without its target retry store: a lane reads that only through `targetCommands`. */
  state: Omit<PlanEngineState, keyof PendingTargetCommandStore>;
  targetCommands: PendingTargetCommandStore;
  /** The single device write seam; also answers whether a device can be turned on. */
  actuator: Actuator;
  /** Observer-owned pending-binary-command store, recorded around every binary dispatch. */
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  /** Observer-owned record, live; `undefined` before the device's first observation. */
  getObservedState: (deviceId: string) => ObserverDeviceRead | undefined;
  /** The device as the executor reads it now — descriptor joined with the observer's record. */
  readDevice: (deviceId: string) => ExecutorDeviceRead | undefined;
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  getSteppedLoadCommandSession: (deviceId: string) => ExecutableSteppedLoadCommandSession;
  markSteppedLoadDesiredStepIssued: (params: MarkSteppedLoadDesiredStepIssuedParams) => void;
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  /** Synchronous claims closing the pre-pending async dispatch race between the lanes. */
  binaryCommandClaim: BinaryCommandClaim;
  steppedCommandClaim: SteppedCommandClaim;
  targetCommandClaim: TargetCommandClaim;
  lifecycleFallback: LifecycleFallbackView;
  /** Prevents a late actuator completion from installing state after authority ended. */
  isAuthorityCurrent: () => boolean;
  /** Lifecycle-only retries scheduled when an already-running ordinary write releases its claim. */
  onBinaryCommandClaimReleased?: (released: BinaryCommandClaimState) => void;
  onSteppedCommandClaimReleased?: (released: SteppedCommandClaimState) => void;
  onTargetCommandClaimReleased?: (released: TargetCommandClaimState) => void;
  /**
   * The executor's binary shed entry (`PlanExecutor.applySheddingToDevice`), so
   * a plan's binary shed and a direct call go through the same public method.
   */
  applySheddingToDevice: (deviceId: string, deviceName: string) => Promise<boolean>;
  recordShedActuation: ActuationRecorder;
  /**
   * Diagnostic-only recorder for the smart-task lifecycle-end disable path:
   * records the `pels_shed` diagnostic and closes the activation attempt
   * WITHOUT stamping the capacity cooldown markers (a lifecycle disable is not
   * capacity pressure).
   */
  recordReleaseShedActuation: ActuationRecorder;
  recordRestoreActuation: ActuationRecorder;
  recordActivationAttemptStarted: ActuationRecorder;
};

/** The ordinary lane stands down while the lifecycle fallback lane holds the device. */
export const isHeldByLifecycleLane = (ctx: ExecutorCommandContext, deviceId: string): boolean => (
  ctx.owner === 'ordinary' && ctx.lifecycleFallback.isActive(deviceId)
);
