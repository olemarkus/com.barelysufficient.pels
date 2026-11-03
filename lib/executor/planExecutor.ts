import type { ExecutionPlan } from '../planContract/executionPlan';
import {
  type ExecutorDeviceReadDeps,
  readExecutorDevice,
  readExecutorDevices,
} from './executorDeviceRead';
import type { PendingTargetObservationSource } from '../ports/pendingTargetCommand';
import type { PlannerExecutionFeedback } from '../ports/plannerExecutionFeedback';
import type { ExecutionState } from './executionState';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { getLogger } from '../logging/logger';
import type { PendingBinaryCommandStore, PendingBinaryConfirmation } from '../observer/pendingBinaryCommands';
import type { PendingBinaryCommand } from '../ports/pendingBinaryCommand';
import type { Actuator } from '../actuator/deviceActuator';
import type { ExecutorCommandContext } from './executorCommandContext';
import type { MarkSteppedLoadDesiredStepIssuedParams } from '../ports/steppedCommand';
import type { ExecutableSteppedLoadCommandSession } from './executablePlan';
import {
  hasStableDeviceActuation,
  resolveConfirmedBinaryCommandReasonCode,
} from './planExecutorPredicates';
import { selectShedActuationRecorder } from './lifecycleReleaseRecording';
import { dispatchPlanActions } from './planExecutorDispatch';
import { ShortfallExecutor, type ShortfallExecutorDeps } from './shortfallExecutor';
import {
  LifecycleFallbackDispatcher,
  type LifecycleFallbackPort,
} from './lifecycleFallbackDispatcher';
import { createCommandClaim } from './commandClaim';
import { buildExecutableObservedDeviceState } from './executablePlanProjection';
import type { DriftObservationDeps } from './driftObservedDevice';
import { hasPlanExecutionDriftAgainstIntent } from './executorConvergence';
import type { PlanActuationResult } from '../planContract/planActuationResult';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { resolveDeviceExecutionState, resolvePlannedCommandValues } from './deviceExecutionState';
import { BatteryExecutor, NO_STORAGE_LANE, type StorageLane } from './batteryExecutor';
import type { StorageLaneBinding } from '../ports/batteryControlOwner';

const logger = getLogger('executor/plan');


/**
 * The executor holds NO view of the device transport. Its device reads are the
 * two owner reads in `ExecutorDeviceReadDeps` — the transport's descriptor and
 * the observer's record — joined per device by `readExecutorDevice`. It issues
 * no transport writes either: every write intent (binary / target / step)
 * routes through the injected `Actuator` seam (`deps.actuator`), so the "only
 * the actuator writes" invariant is structural — there is no write surface here
 * to call. See `notes/state-management/snapshot-decomposition.md` (stage 5) and
 * `notes/state-management/actuator-write-seam.md`.
 */
export type PlanExecutorDeps = ShortfallExecutorDeps & ExecutorDeviceReadDeps & {
  persistLastControlledMs: (lastControlledMs: Record<string, number>) => void;
  /**
   * Observer-owned accepted-write counter, used to tell whether the observed
   * world moved while a plan build yielded. Not a clock and not a freshness
   * label — only "same world or not".
   */
  getObservationRevision: () => number;
  /**
   * The single device write seam. Step writes route through here
   * (`apply({ kind: 'step', ... })`); binary/target write sites migrate onto
   * the actuator in PR1b-2/PR1b-3. See
   * `notes/state-management/actuator-write-seam.md`.
   */
  actuator: Actuator;
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  markSteppedLoadDesiredStepIssued: (params: MarkSteppedLoadDesiredStepIssuedParams) => void;
  getSteppedLoadCommandSession: (deviceId: string) => ExecutableSteppedLoadCommandSession;
  syncLivePlanStateAfterTargetActuation: (source: PendingTargetObservationSource) => boolean | void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  /**
   * Observer-owned pending-binary-command store. The executor's
   * dispatch path (`binaryControlDispatch.ts`) writes/clears entries
   * through this store as part of PR #4 of the observer/transport
   * split. `ExecutionState` owns its backing field; plan-side read sites
   * receive readonly entries through `PlanExecutionRead`.
   */
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  /**
   * The storage lane's binding (`batteryExecutor.ts`): Main's battery control
   * owner, built before the plan engine; `none` in a meter area, which builds
   * no storage lane at all.
   */
  storageLane: StorageLaneBinding;
  inverterLane: import('../ports/inverterControl').InverterExecution;
};

export class PlanExecutor {
  private lastControlledPersistenceDirty = false;
  private controlPersistenceBatchDepth = 0;
  private readonly shortfallExecutor: ShortfallExecutor;

  /** The storage lane; a meter area builds none, and its plans carry no storage decision. */
  private readonly storage: StorageLane;

  /** The ordinary lane's command context, built once; the lifecycle lane spreads it. */
  private readonly ctx: ExecutorCommandContext;
  private readonly lifecycleFallback: LifecycleFallbackDispatcher;

  constructor(private readonly deps: PlanExecutorDeps, private readonly execution: ExecutionState,
    private readonly feedback: PlannerExecutionFeedback) {
    this.shortfallExecutor = new ShortfallExecutor(deps, feedback);
    this.ctx = {
      homeId: deps.homeId,
      owner: 'ordinary',
      execution,
      feedback,
      targetCommands: execution,
      actuator: deps.actuator,
      pendingBinaryCommandStore: deps.pendingBinaryCommandStore,
      getObservedState: deps.getObservedState,
      readDevice: (deviceId) => readExecutorDevice(deps, deviceId),
      getCapacityDryRun: deps.getCapacityDryRun,
      getOperatingMode: deps.getOperatingMode,
      getSteppedLoadCommandSession: deps.getSteppedLoadCommandSession,
      markSteppedLoadDesiredStepIssued: deps.markSteppedLoadDesiredStepIssued,
      syncLivePlanStateAfterTargetActuation: deps.syncLivePlanStateAfterTargetActuation,
      binaryCommandClaim: createCommandClaim<boolean>(),
      steppedCommandClaim: createCommandClaim<string>(),
      targetCommandClaim: createCommandClaim<number>(),
      lifecycleFallback: {
        isActive: (deviceId) => this.lifecycleFallback.isActive(deviceId),
        getOwnedTargetPending: (deviceId) => this.lifecycleFallback.getOwnedTargetPending(deviceId),
      },
      isAuthorityCurrent: () => true,
      recordShedActuation: (deviceId, name, now) => this.recordShedActuation(deviceId, name, now),
      recordReleaseShedActuation: (deviceId, name, now) => this.recordReleaseShedActuation(deviceId, name, now),
      recordRestoreActuation: (deviceId, name, now) => this.recordRestoreActuation(deviceId, name, now),
      recordActivationAttemptStarted: (deviceId, name, now) => (
        feedback.recordActivationAttemptStarted(deviceId, name, now)
      ),
    };
    this.lifecycleFallback = new LifecycleFallbackDispatcher(this.ctx);
    this.storage = deps.storageLane.kind === 'none' ? NO_STORAGE_LANE : new BatteryExecutor(
      deps.storageLane.owner,
      deps.actuator,
      deps,
      deps.getPowerTracker,
      execution.actuation,
      this.ctx.recordRestoreActuation,
    );
  }

  /** Judge the storage lane's setpoints in flight against this reading. */
  public syncStorageCommands(): void {
    this.storage.sync(Date.now());
  }

  /**
   * Devices the plan being applied holds off by a hold that is NOT capacity
   * pressure (`DevicePlanDevice.nonCapacityHoldShed`: "Only PELS starts this
   * device", or a smart task's deferred hour). Replaced with each applied plan; a
   * binary OFF confirmed after a later plan is read against that later plan.
   */
  private nonCapacityHoldShedIds: ReadonlySet<string> = new Set();

  private recordShedActuation(deviceId: string, name: string, now: number): void {
    // A hold is a planning decision, not capacity pressure, exactly like a smart
    // task's lifecycle release: turning the device off must not start the shed
    // cooldown or note instability, which would hold every other off device in
    // the home for 60 s and double the restore back-off at each hour a task
    // defers (owner ruling, 2026-09-25).
    if (this.nonCapacityHoldShedIds.has(deviceId)) {
      this.recordReleaseShedActuation(deviceId, name, now);
      return;
    }
    this.feedback.noteInstability(now);
    this.execution.actuation.markShed(deviceId, now);
    this.recordReleaseShedActuation(deviceId, name, now);
  }

  // Lifecycle-end release variant: skips the shed-cooldown / instability clocks because a
  // release is the smart task handing the device back to its configured shed posture, not a
  // capacity-driven shed.
  private recordReleaseShedActuation(deviceId: string, name: string, now: number): void {
    this.recordControlTimestamp(deviceId, now);
    this.deps.deviceDiagnostics?.recordControlEvent({ kind: 'pels_shed', deviceId, name, nowTs: now });
    this.feedback.closeActivationAttemptForShed(deviceId, name, now);
  }

  private recordRestoreActuation(deviceId: string, name: string, now: number): void {
    this.execution.actuation.markRestore(deviceId, now);
    this.recordControlTimestamp(deviceId, now);
    this.deps.deviceDiagnostics?.recordControlEvent({ kind: 'pels_restore', deviceId, name, nowTs: now });
  }

  private recordControlTimestamp(deviceId: string, now: number): void {
    this.execution.actuation.markControlled(deviceId, now);
    this.lastControlledPersistenceDirty = true;
  }

  public handleConfirmedBinaryCommand(confirmation: PendingBinaryConfirmation): void {
    const { liveDevice, pending, confirmedAtMs: now } = confirmation;
    const deviceId = liveDevice.id;
    logger.info({
      event: 'binary_command_applied',
      deviceId,
      deviceName: liveDevice.name,
      controlAxis: 'binary',
      desired: pending.desired,
      reasonCode: resolveConfirmedBinaryCommandReasonCode(pending),
    });

    if (pending.desired) {
      // Any confirmed turn-on undoes PELS's shed at once: an owner who switches
      // the device off again before the next build is not overruled later.
      this.feedback.noteShedReleased(deviceId);
      if (pending.logContext === 'capacity_control_off') {
        this.execution.actuation.clearShed(deviceId);
      } else {
        this.recordRestoreActuation(deviceId, liveDevice.name, now);
        this.ctx.recordActivationAttemptStarted(deviceId, liveDevice.name, now);
      }

    } else {
      // Binary OFF confirmed. The lifecycle-vs-capacity recorder selection
      // comes from the shared helper so it stays in lockstep with the direct path: a
      // smart-task lifecycle-end disable records diagnostics only via the release recorder
      // (no capacity cooldown markers, because it is a planning decision, not capacity
      // pressure); a capacity shed stamps the markers via recordShedActuation.
      selectShedActuationRecorder(pending.lifecycleRelease, this.ctx)(deviceId, liveDevice.name, now);
    }

    this.flushLastControlledPersistence();
  }

  private flushLastControlledPersistence(): void {
    if (this.controlPersistenceBatchDepth > 0) return;
    if (!this.lastControlledPersistenceDirty) return;
    try {
      this.deps.persistLastControlledMs(this.execution.actuation.lastDeviceControlledMs);
      this.lastControlledPersistenceDirty = false;
    } catch (error) {
      logger.error({
        event: 'executor_plan_error',
        msg: 'Failed to persist device last-controlled timestamps',
        err: error as Error,
      });
    }
  }

  public getLifecycleFallbackPort(): LifecycleFallbackPort {
    return this.lifecycleFallback;
  }

  /** The observer's accepted-write counter. See `PlanEngine.getObservationRevision`. */
  public getObservationRevision(): number {
    return this.deps.getObservationRevision();
  }

  /**
   * The three readers the drift comparison needs, each bound to the layer that
   * owns its answer: the observer projection for what the device is doing, this
   * executor's own stores for what PELS asked it to do, and the external-off
   * posture. Exposed as a bundle so the caller composes nothing itself — and so
   * no `PlanInputDevice` has to travel here to carry an observation.
   */
  public driftObservationDeps(): DriftObservationDeps {
    return {
      getObservedState: (deviceId) => readExecutorDevice(this.deps, deviceId),
      getCommandState: (deviceId) => this.resolveCommandState(
        deviceId, this.deps.pendingBinaryCommandStore.get(deviceId),
      ),
      isExternalOffHeld: (deviceId) => this.feedback.isExternalOffHeld(deviceId),
      hasStorageDrift: (device) => this.storage.hasDrift(device),
      hasStorageReleaseDrift: (intent) => this.storage.hasReleaseDrift(intent),
    };
  }

  private resolveCommandState(
    deviceId: string,
    pendingBinary: PendingBinaryCommand | undefined,
  ): ReturnType<DriftObservationDeps['getCommandState']> {
    const session = this.deps.getSteppedLoadCommandSession(deviceId);
    const target = this.execution.pendingTargetCommands[deviceId];
    return {
      target: target ? { kind: 'pending', desired: target.desired } : { kind: 'none' },
      binary: pendingBinary
        ? { kind: 'pending', desired: pendingBinary.desired }
        : { kind: 'none' },
      step: session.stepCommandPending
        ? { kind: 'pending' }
        : { kind: 'none' },
    };
  }

  /**
   * Live read only: never settles stores, schedules work, or issues commands. An
   * expired pending command reads as none here and is left for the settle sweep
   * to expire, so a settings-UI read cannot run the command lifecycle.
   */
  public getDeviceExecutionStates(plan: ExecutionPlan): ReadonlyMap<string, DeviceExecutionState> {
    const reads = this.driftObservationDeps();
    return new Map(plan.devices.flatMap((decision) => {
      const device = decision.commands;
      // A device that has left the managed set since this plan was built is no
      // longer tracked (the runtime snapshot drops unmanaged devices), so it
      // has no configuration and the observer stops reading it: it has no
      // execution state, rather than an unavailable one. The next plan drops
      // it. A tracked device Homey reports unavailable keeps its state.
      if (this.deps.getDeviceConfiguration(device.id) === undefined) return [];
      const live = readExecutorDevice(this.deps, device.id);
      const observed = live ? buildExecutableObservedDeviceState(live, live.steppedLoadProfile) : undefined;
      const execution = resolveDeviceExecutionState(device, observed, {
        ...this.resolveCommandState(device.id, this.deps.pendingBinaryCommandStore.peekActive(device.id)),
        target: this.execution.pendingTargetCommands[device.id] ?? null,
        unansweredStepCommands: this.deps.getSteppedLoadCommandSession(device.id).unansweredStepCommands,
      }, reads.isExternalOffHeld(device.id));
      return [[device.id, {
        ...execution,
        ...(live && hasObservedMeasuredPower(live) ? { currentDrawKw: live.measuredPowerKw } : {}),
      }] as const];
    }));
  }

  /**
   * The plan just built is what PELS now stands behind: a command it no longer
   * asks for, or for a device that left this home's plan, leaves the contest
   * record, so a later send of the same value after the device moved is a new
   * command, not a correction. Setpoints are compared as the actuator resolves
   * them, which is the value a send carries.
   */
  public retainContestedCommands(plan: ExecutionPlan): void {
    this.execution.controlContests.retainPlanned(this.deps.homeId, new Map(plan.devices.map((decision) => {
      const device = decision.commands;
      const planned = resolvePlannedCommandValues(device, this.feedback.isExternalOffHeld(device.id));
      return [device.id, {
        ...planned,
        temperature: this.resolvePlannedTemperature(device.id, planned.temperature),
      }] as const;
    })));
  }

  /** A device with no setpoint the transport can resolve takes no temperature command. */
  private resolvePlannedTemperature(deviceId: string, target: number | null): number | null {
    if (target === null) return null;
    try {
      return this.deps.actuator.resolveTemperatureTarget(deviceId, target);
    } catch {
      return null;
    }
  }

  /**
   * Does the plan just built leave work for the executor, judged from the
   * plan's own view of each device? It stays beside
   * `hasPlanExecutionDriftAgainstIntent` because the two ask different
   * questions. Drift compares the LIVE observation with the intent, and the
   * apply gate drops its answer once the observer has moved since the build.
   * This compares the plan's desired step with the plan's current one, which
   * drift never does (its step axis checks the effective step against the
   * observed one), and covers an uncontrolled device's restore, for which drift
   * sets no expectation. The stepped checks read the stepped intent dispatch
   * carries out, so a device the projection holds is not reported as work.
   *
   * Only a pending turn-ON holds the binary operations back, as the plan
   * device's `binaryCommandPending` did before the execution contract moved
   * here; see `hasStableDeviceActuation`.
   */
  public hasStablePlanActuation(plan: ExecutionPlan): boolean {
    return plan.devices.some((device) => hasStableDeviceActuation(
      device,
      this.deps.getSteppedLoadCommandSession(device.commands.id),
      this.deps.pendingBinaryCommandStore.hasActiveTurnOn(device.commands.id),
      this.feedback.isStandingShed(device.commands.id),
    ));
  }

  /**
   * Does the executor still have work to do against the plan just built? See
   * `PlanEngine.hasExecutionWorkOutstanding`.
   *
   * The plan was decided against the observations as of
   * `observationRevisionAtBuild`. If the observer has accepted a write since,
   * this plan has not been decided against the world it would now be applied
   * to, and acting anyway is an apply-without-decide, the shape that breached
   * the hard cap (`inc_26449fb9`). Decline; the next whole-home reading
   * re-decides against the observation that moved.
   */
  public hasExecutionWorkOutstanding(plan: ExecutionPlan, observationRevisionAtBuild: number): boolean {
    if (this.getObservationRevision() !== observationRevisionAtBuild) return false;
    return this.deps.inverterLane.hasWork(plan.inverterDecisions)
      || hasPlanExecutionDriftAgainstIntent(plan, this.driftObservationDeps());
  }

  public isInverterReleaseRecoveryReady(): boolean { return this.deps.inverterLane.releaseRecoveryReady(); }

  public getPendingInverterReleaseCount(plan: ExecutionPlan): number {
    return this.deps.inverterLane.pendingReleaseCount(plan.inverterDecisions);
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    await this.shortfallExecutor.handleShortfall(deficitKw);
  }

  public async handleShortfallCleared(): Promise<void> {
    await this.shortfallExecutor.handleShortfallCleared();
  }

  public async applyPlanActions(plan: ExecutionPlan): Promise<PlanActuationResult> {
    if (this.deps.getCapacityDryRun()) {
      const release = await this.deps.inverterLane.apply(
        plan.inverterDecisions.filter((decision) => decision.kind === 'release'),
      );
      return { deviceWriteCount: 0, commandRequestCount: release.commandRequestCount,
        deviceApplyFailureCount: release.failureCount,
        pendingInverterReleaseCount: release.pendingInverterReleaseCount };
    }

    this.nonCapacityHoldShedIds = new Set(
      plan.devices.filter((device) => device.nonCapacityHoldShed).map((device) => device.commands.id),
    );
    this.controlPersistenceBatchDepth += 1;
    try {
      const result = await dispatchPlanActions(this.ctx, plan, readExecutorDevices(this.deps), this.storage);
      const inverterResult = await this.deps.inverterLane.apply(plan.inverterDecisions);
      return { ...result,
        commandRequestCount: result.commandRequestCount + inverterResult.commandRequestCount,
        deviceApplyFailureCount: result.deviceApplyFailureCount + inverterResult.failureCount,
        pendingInverterReleaseCount: inverterResult.pendingInverterReleaseCount,
      };
    } finally {
      this.controlPersistenceBatchDepth = Math.max(0, this.controlPersistenceBatchDepth - 1);
      this.flushLastControlledPersistence();
    }
  }
}
