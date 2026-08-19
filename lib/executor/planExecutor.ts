import type { DeviceObservation } from '../device/deviceObservation';
import type { DevicePlan, PlanInputDevice, ShedBehavior } from '../plan/planTypes';
import type { PendingTargetObservationSource } from '../plan/planTypes';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';

/**
 * The executor's **read-only** view of the device transport: snapshot reads
 * only (`DeviceObservation`). The executor issues no transport writes — every
 * write intent (binary / target / step) routes through the injected `Actuator`
 * seam (`deps.actuator`), so the device-transport view carries no write methods.
 * This makes the "only the actuator writes" invariant structural: there is no
 * write surface here to call. The abstract `DeviceObservation` interface keeps
 * the executor off the concrete `DeviceTransport` class — see
 * `notes/state-management/observer-transport-split.md` and
 * `notes/state-management/actuator-write-seam.md`.
 */
export type PlanExecutorDeviceTransport = DeviceObservation;
import type { ExecutorDeviceSnapshot } from './executablePlan';
import type { PlanEngineState } from '../plan/planState';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  closeActivationAttemptForShedActuation,
  recordActivationAttemptStarted,
  recordDiagnosticsRestore,
  recordDiagnosticsShed,
} from '../plan/planExecutorSupport';
import { getLogger } from '../logging/logger';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { Actuator } from '../actuator/deviceActuator';

const logger = getLogger('executor/plan');
import type { PlanExecutorTargetContext } from './targetExecutor';
import type { PlanExecutorSteppedContext } from './steppedLoadExecutor';
import type { PlanExecutorBinaryContext } from './binaryExecutor';
import {
  hasStableBinaryReleaseActuation,
  hasStableSteppedLoadBinaryRestoreActuation,
  hasStableSteppedLoadStepActuation,
  hasStableUncontrolledRestoreActuation,
  resolveConfirmedBinaryCommandReasonCode,
  resolveRestoreLogSource,
} from './planExecutorPredicates';
import { selectShedActuationRecorder } from './lifecycleReleaseRecording';
import {
  applySheddingToDeviceImpl,
  dispatchPlanActions,
  type PlanExecutorCore,
} from './planExecutorDispatch';
import { ShortfallExecutor, type ShortfallExecutorDeps } from './shortfallExecutor';
import {
  LifecycleFallbackDispatcher,
  type LifecycleFallbackPort,
} from './lifecycleFallbackDispatcher';
import { createTargetCommandClaim } from './targetCommandClaim';
import { createSteppedCommandClaim } from './steppedCommandClaim';
import { createBinaryCommandClaim } from './binaryCommandClaim';
import { buildExecutableObservedDeviceStateFromSnapshot } from './executablePlanProjection';

import type { PlanActuationResult } from '../planContract/planActuationResult';

export type PlanExecutorDeps = ShortfallExecutorDeps & {
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  deviceManager: PlanExecutorDeviceTransport;
  /**
   * Observer-owned observed-state read (stage 5). The target executor sources
   * observed capability values from this projection accessor instead of the
   * transport snapshot; `undefined` until the first observation for a device.
   */
  getObservedState: (deviceId: string) => ObservedDeviceState | undefined;
  /**
   * The single device write seam. Step writes route through here
   * (`apply({ kind: 'step', ... })`); binary/target write sites migrate onto
   * the actuator in PR1b-2/PR1b-3. See
   * `notes/state-management/actuator-write-seam.md`.
   */
  actuator: Actuator;
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getShedBehavior: (deviceId: string) => ShedBehavior;
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
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  /**
   * Observer-owned pending-binary-command store. The executor's
   * dispatch path (`binaryControlDispatch.ts`) writes/clears entries
   * through this store as part of PR #4 of the observer/transport
   * split. Plan-side read sites still consult the backing field on
   * `PlanEngineState.pendingBinaryCommands` (mutated only via the
   * store).
   */
  pendingBinaryCommandStore: PendingBinaryCommandStore;
};

export class PlanExecutor {
  private lastControlledPersistenceDirty = false;
  private controlPersistenceBatchDepth = 0;
  private readonly shortfallExecutor: ShortfallExecutor;

  constructor(private deps: PlanExecutorDeps, private state: PlanEngineState) {
    this.shortfallExecutor = new ShortfallExecutor(deps, state);
  }

  private readonly boundGetShedBehavior = (deviceId: string) => this.getShedBehavior(deviceId);
  private readonly boundBuildBinaryControlTransport = () => this.buildBinaryControlTransport();
  private readonly boundMarkSteppedLoadDesiredStepIssued = (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
    confirmationPolicy?: 'required' | 'assume_applied';
  }): void => this.markSteppedLoadDesiredStepIssued(params);
  private readonly boundRecordShedActuation = (
    deviceId: string,
    name: string,
    now: number,
  ): void => this.recordShedActuation(deviceId, name, now);
  private readonly boundRecordRestoreActuation = (
    deviceId: string,
    name: string,
    now: number,
  ): void => this.recordRestoreActuation(deviceId, name, now);
  private readonly boundRecordActivationAttemptStarted = (
    deviceId: string,
    name: string,
    now: number,
  ): void => {
    recordActivationAttemptStarted({
      state: this.state,
      diagnostics: this.deps.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
  };
  private readonly boundGetRestoreLogSource = (deviceId: string): 'shed_state' | 'current_plan' => (
    resolveRestoreLogSource(this.state, deviceId)
  );
  private targetExecutorContext?: PlanExecutorTargetContext;
  private steppedExecutorContext?: PlanExecutorSteppedContext;
  private binaryExecutorContext?: PlanExecutorBinaryContext;
  private lifecycleFallbackDispatcher?: LifecycleFallbackDispatcher;
  private readonly targetCommandClaim = createTargetCommandClaim();
  private readonly steppedCommandClaim = createSteppedCommandClaim();
  private readonly binaryCommandClaim = createBinaryCommandClaim();

  private get deviceManager(): PlanExecutorDeviceTransport {
    return this.deps.deviceManager;
  }

  private get capacityDryRun(): boolean {
    return this.deps.getCapacityDryRun();
  }

  private get operatingMode(): string {
    return this.deps.getOperatingMode();
  }

  private buildBinaryControlTransport() {
    return {
      observation: this.deviceManager,
      pendingBinaryCommandStore: this.deps.pendingBinaryCommandStore,
      actuator: this.deps.actuator,
    };
  }

  private recordShedActuation(deviceId: string, name: string, now: number): void {
    this.state.lastInstabilityMs = now;
    this.state.lastDeviceShedMs[deviceId] = now;
    this.recordReleaseShedActuation(deviceId, name, now);
  }

  // Lifecycle-end release variant: skips the shed-cooldown / instability clocks because a
  // release is the smart task handing the device back to its configured shed posture, not a
  // capacity-driven shed. Property form so it can be passed as a dep without a bound wrapper.
  private readonly recordReleaseShedActuation = (deviceId: string, name: string, now: number): void => {
    this.recordControlTimestamp(deviceId, now);
    recordDiagnosticsShed({
      diagnostics: this.deps.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
    closeActivationAttemptForShedActuation({
      state: this.state,
      diagnostics: this.deps.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
  };

  private recordRestoreActuation(deviceId: string, name: string, now: number): void {
    this.state.lastRestoreMs = now;
    this.recordControlTimestamp(deviceId, now);
    this.state.lastDeviceRestoreMs[deviceId] = now;
    recordDiagnosticsRestore({
      diagnostics: this.deps.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
  }

  private markSteppedLoadDesiredStepIssued(params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
    confirmationPolicy?: 'required' | 'assume_applied';
  }): void {
    this.deps.markSteppedLoadDesiredStepIssued(params);
  }

  private getShedBehavior(deviceId: string): ShedBehavior {
    return this.deps.getShedBehavior(deviceId);
  }

  private recordControlTimestamp(deviceId: string, now: number): void {
    this.state.lastDeviceControlledMs[deviceId] = now;
    this.lastControlledPersistenceDirty = true;
  }

  public handleConfirmedBinaryCommand(params: {
    deviceId: string;
    liveDevice: Pick<PlanInputDevice, 'id' | 'name'>;
    pending: PlanEngineState['pendingBinaryCommands'][string];
    confirmedAtMs?: number;
  }): void {
    const { deviceId, liveDevice, pending } = params;
    const now = params.confirmedAtMs ?? Date.now();
    logger.info({
      event: 'binary_command_applied',
      deviceId,
      deviceName: liveDevice.name,
      controlAxis: 'binary',
      desired: pending.desired,
      reasonCode: resolveConfirmedBinaryCommandReasonCode(pending),
    });

    if (pending.desired) {
      if (pending.logContext === 'capacity_control_off') {
        // Route through the narrow mutators so the surplus-posture stamp
        // (`surplusOnlyShedByDevice`) is cleared in lockstep with the decision clock.
        this.state.clearDeviceShed(deviceId);
        this.state.clearShedDecision(deviceId);
      } else {
        this.recordRestoreActuation(deviceId, liveDevice.name, now);
        recordActivationAttemptStarted({
          state: this.state,
          diagnostics: this.deps.deviceDiagnostics,
          deviceId,
          name: liveDevice.name,
          nowTs: now,
        });
        this.state.clearPendingSwapTarget(deviceId);
      }

    } else {
      // Binary OFF confirmed. The lifecycle-vs-capacity recorder selection
      // comes from the shared helper so it stays in lockstep with the direct path: a
      // smart-task lifecycle-end disable records diagnostics only via the release recorder
      // (no capacity cooldown markers, because it is a planning decision, not capacity
      // pressure); a capacity shed stamps the markers via recordShedActuation.
      selectShedActuationRecorder({
        lifecycleRelease: pending.lifecycleRelease,
        recordShedActuation: this.boundRecordShedActuation,
        recordReleaseShedActuation: this.recordReleaseShedActuation,
      })(deviceId, liveDevice.name, now);
    }

    this.flushLastControlledPersistence();
  }

  private flushLastControlledPersistence(): void {
    if (this.controlPersistenceBatchDepth > 0) return;
    if (!this.lastControlledPersistenceDirty) return;
    try {
      this.deps.persistLastControlledMs(this.state.lastDeviceControlledMs);
      this.lastControlledPersistenceDirty = false;
    } catch (error) {
      logger.error({
        event: 'executor_plan_error',
        msg: 'Failed to persist device last-controlled timestamps',
        err: error as Error,
      });
    }
  }

  private get latestTargetSnapshot(): ExecutorDeviceSnapshot[] {
    return this.deviceManager.getSnapshot();
  }

  private buildTargetExecutorContext(): PlanExecutorTargetContext {
    if (!this.targetExecutorContext) {
      this.targetExecutorContext = {
        state: this.state,
        getObservedTemperatureValue: (deviceId) => (
          this.deps.getObservedState(deviceId)?.targets[0]?.value
        ),
        getLifecycleOwnedPendingTargetCommand: (deviceId) => (
          this.lifecycleFallbackDispatcher?.getOwnedTargetPending(deviceId)
        ),
        isLifecycleFallbackActive: (deviceId) => (
          this.lifecycleFallbackDispatcher?.isActive(deviceId) === true
        ),
        targetCommandClaim: this.targetCommandClaim,
        targetCommandOwner: 'ordinary',
        actuator: this.deps.actuator,
        operatingMode: this.operatingMode,
        syncLivePlanStateAfterTargetActuation: this.deps.syncLivePlanStateAfterTargetActuation,
        logTargetRetryComparison: this.deps.logTargetRetryComparison,
        recordShedActuation: this.boundRecordShedActuation,
        recordRestoreActuation: this.boundRecordRestoreActuation,
        recordActivationAttemptStarted: this.boundRecordActivationAttemptStarted,
        deviceDiagnostics: this.deps.deviceDiagnostics,
      };
    }

    this.targetExecutorContext.state = this.state;
    this.targetExecutorContext.operatingMode = this.operatingMode;
    this.targetExecutorContext.syncLivePlanStateAfterTargetActuation = this.deps.syncLivePlanStateAfterTargetActuation;
    this.targetExecutorContext.logTargetRetryComparison = this.deps.logTargetRetryComparison;
    this.targetExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.targetExecutorContext;
  }

  private buildSteppedExecutorContext(): PlanExecutorSteppedContext {
    if (!this.steppedExecutorContext) {
      this.steppedExecutorContext = {
        state: this.state,
        steppedCommandClaim: this.steppedCommandClaim,
        steppedCommandOwner: 'ordinary',
        binaryCommandClaim: this.binaryCommandClaim,
        binaryCommandOwner: 'ordinary',
        isLifecycleFallbackActive: (deviceId) => (
          this.lifecycleFallbackDispatcher?.isActive(deviceId) === true
        ),
        observation: this.deviceManager,
        buildBinaryControlTransport: this.boundBuildBinaryControlTransport,
        markSteppedLoadDesiredStepIssued: this.boundMarkSteppedLoadDesiredStepIssued,
        recordShedActuation: this.boundRecordShedActuation,
        recordRestoreActuation: this.boundRecordRestoreActuation,
        getRestoreLogSource: this.boundGetRestoreLogSource,
        // Route step writes through the single actuator seam; the `{ requested: false }`
        // fallback matches the absent-stepped-surface arm of SteppedLoadStepRequestResult.
        requestSteppedLoadStep: (params) => this.deps.actuator.apply({ kind: 'step', ...params })
          .then((outcome) => (
            outcome.requested && outcome.kind === 'step'
              ? outcome.steppedResult
              : { requested: false as const }
          )),
        deviceDiagnostics: this.deps.deviceDiagnostics,
      };
    }

    this.steppedExecutorContext.state = this.state;
    this.steppedExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.steppedExecutorContext;
  }

  private buildBinaryExecutorContext(): PlanExecutorBinaryContext {
    if (!this.binaryExecutorContext) {
      this.binaryExecutorContext = {
        state: this.state,
        observation: this.deviceManager,
        capacityDryRun: this.capacityDryRun,
        buildBinaryControlTransport: this.boundBuildBinaryControlTransport,
        getRestoreLogSource: this.boundGetRestoreLogSource,
        recordShedActuation: this.boundRecordShedActuation,
        recordReleaseShedActuation: this.recordReleaseShedActuation,
        recordRestoreActuation: this.boundRecordRestoreActuation,
        deviceDiagnostics: this.deps.deviceDiagnostics,
        binaryCommandClaim: this.binaryCommandClaim,
        binaryCommandOwner: 'ordinary',
        isLifecycleFallbackActive: (deviceId) => (
          this.lifecycleFallbackDispatcher?.isActive(deviceId) === true
        ),
      };
    }

    this.binaryExecutorContext.state = this.state;
    this.binaryExecutorContext.capacityDryRun = this.capacityDryRun;
    this.binaryExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.binaryExecutorContext;
  }

  private dispatchCore?: PlanExecutorCore;

  private getDispatchCore(): PlanExecutorCore {
    if (!this.dispatchCore) {
      this.dispatchCore = {
        buildTargetExecutorContext: () => this.buildTargetExecutorContext(),
        buildSteppedExecutorContext: () => this.buildSteppedExecutorContext(),
        buildBinaryExecutorContext: () => this.buildBinaryExecutorContext(),
        getShedBehavior: this.boundGetShedBehavior,
        getSteppedLoadCommandSession: this.deps.getSteppedLoadCommandSession,
        recordReleaseShedActuation: this.recordReleaseShedActuation,
        latestTargetSnapshot: () => this.latestTargetSnapshot,
        capacityDryRun: () => this.capacityDryRun,
        state: this.state,
        flushLastControlledPersistence: () => this.flushLastControlledPersistence(),
        applySheddingToDevice: (deviceId, deviceName, reason) => (
          this.applySheddingToDevice(deviceId, deviceName, reason)
        ),
      };
    }
    this.dispatchCore.state = this.state;
    return this.dispatchCore;
  }

  public getLifecycleFallbackPort(): LifecycleFallbackPort {
    if (!this.lifecycleFallbackDispatcher) {
      this.lifecycleFallbackDispatcher = new LifecycleFallbackDispatcher({
        buildBinaryExecutorContext: () => this.buildBinaryExecutorContext(),
        buildTargetExecutorContext: () => this.buildTargetExecutorContext(),
        buildSteppedExecutorContext: () => this.buildSteppedExecutorContext(),
        recordReleaseShedActuation: this.recordReleaseShedActuation,
        targetCommandClaim: this.targetCommandClaim,
        capacityDryRun: () => this.capacityDryRun,
        refreshObserved: (deviceId) => {
          const snapshot = this.deviceManager.getSnapshotByDeviceId(deviceId);
          if (!snapshot) return undefined;
          const observedState = this.deps.getObservedState(deviceId);
          return buildExecutableObservedDeviceStateFromSnapshot({
            ...snapshot,
            ...(observedState ? { ...observedState } : {}),
          });
        },
      });
    }
    return this.lifecycleFallbackDispatcher;
  }

  public async applySheddingToDevice(deviceId: string, deviceName: string, reason?: string): Promise<boolean> {
    return applySheddingToDeviceImpl(this.getDispatchCore(), deviceId, deviceName, reason);
  }

  public hasStablePlanActuation(plan: DevicePlan): boolean {
    return plan.devices.some((dev) => (
      hasStableUncontrolledRestoreActuation(dev, this.state)
      || hasStableBinaryReleaseActuation(dev)
      || hasStableSteppedLoadStepActuation(
        dev,
        this.deps.getSteppedLoadCommandSession(dev.id),
      )
      || hasStableSteppedLoadBinaryRestoreActuation(dev)
    ));
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    await this.shortfallExecutor.handleShortfall(deficitKw);
  }

  public async handleShortfallCleared(): Promise<void> {
    await this.shortfallExecutor.handleShortfallCleared();
  }

  public async applyPlanActions(plan: DevicePlan): Promise<PlanActuationResult> {
    if (!plan || !Array.isArray(plan.devices)) {
      return { deviceWriteCount: 0, commandRequestCount: 0, writtenDeviceIds: [] };
    }

    this.controlPersistenceBatchDepth += 1;
    try {
      return await dispatchPlanActions(this.getDispatchCore(), plan);
    } finally {
      this.controlPersistenceBatchDepth = Math.max(0, this.controlPersistenceBatchDepth - 1);
      this.flushLastControlledPersistence();
    }
  }
}
