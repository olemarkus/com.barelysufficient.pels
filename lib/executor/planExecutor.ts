import type {
  DevicePlan, PendingTargetObservationSource, ShedBehavior,
} from '../plan/planTypes';
import {
  type ExecutorDeviceReadDeps,
  readExecutorDevice,
  readExecutorDevices,
} from './executorDeviceRead';
import type { PlanEngineState } from '../plan/planState';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  closeActivationAttemptForShedActuation,
  recordActivationAttemptStarted,
} from './executorSupport';
import { getLogger } from '../logging/logger';
import type { PendingBinaryCommandStore, PendingBinaryConfirmation } from '../observer/pendingBinaryCommands';
import type { PendingBinaryCommand } from '../observer/pendingBinaryCommandTypes';
import type { Actuator } from '../actuator/deviceActuator';
import type { ExecutorCommandContext } from './executorCommandContext';
import type { MarkSteppedLoadDesiredStepIssuedParams } from '../ports/steppedCommand';
import type { ExecutableSteppedLoadCommandSession } from './executablePlan';
import {
  hasStableBinaryReleaseActuation,
  hasStableSteppedLoadBinaryRestoreActuation,
  hasStableSteppedLoadStepActuation,
  hasStableUncontrolledRestoreActuation,
  resolveConfirmedBinaryCommandReasonCode,
} from './planExecutorPredicates';
import { selectShedActuationRecorder } from './lifecycleReleaseRecording';
import { dispatchPlanActions } from './planExecutorDispatch';
import { ShortfallExecutor, type ShortfallExecutorDeps } from './shortfallExecutor';
import {
  LifecycleFallbackDispatcher,
  type LifecycleFallbackPort,
} from './lifecycleFallbackDispatcher';
import { createTargetCommandClaim } from './targetCommandClaim';
import { createSteppedCommandClaim } from './steppedCommandClaim';
import { createBinaryCommandClaim } from './binaryCommandClaim';
import { buildExecutablePlan, buildExecutableObservedDeviceState } from './executablePlanProjection';
import { buildExecutableSteppedLoadIntent } from './executableSteppedLoadProjection';
import type { DriftObservationDeps } from './driftObservedDevice';
import type { PlanActuationResult } from '../planContract/planActuationResult';
import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { resolveDeviceExecutionState } from './deviceExecutionState';
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
  getShedBehavior: (deviceId: string) => ShedBehavior;
  markSteppedLoadDesiredStepIssued: (params: MarkSteppedLoadDesiredStepIssuedParams) => void;
  getSteppedLoadCommandSession: (deviceId: string) => ExecutableSteppedLoadCommandSession;
  syncLivePlanStateAfterTargetActuation: (source: PendingTargetObservationSource) => boolean | void;
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
  /**
   * The storage lane's binding (`batteryExecutor.ts`): Main's battery control
   * owner, built before the plan engine; `none` in a meter area, which builds
   * no storage lane at all.
   */
  storageLane: StorageLaneBinding;
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

  constructor(private readonly deps: PlanExecutorDeps, private readonly state: PlanEngineState) {
    this.shortfallExecutor = new ShortfallExecutor(deps, state);
    this.ctx = {
      owner: 'ordinary',
      state,
      targetCommands: state,
      actuator: deps.actuator,
      pendingBinaryCommandStore: deps.pendingBinaryCommandStore,
      getObservedState: deps.getObservedState,
      readDevice: (deviceId) => readExecutorDevice(deps, deviceId),
      getCapacityDryRun: deps.getCapacityDryRun,
      getOperatingMode: deps.getOperatingMode,
      getShedBehavior: deps.getShedBehavior,
      getSteppedLoadCommandSession: deps.getSteppedLoadCommandSession,
      markSteppedLoadDesiredStepIssued: deps.markSteppedLoadDesiredStepIssued,
      syncLivePlanStateAfterTargetActuation: deps.syncLivePlanStateAfterTargetActuation,
      binaryCommandClaim: createBinaryCommandClaim(),
      steppedCommandClaim: createSteppedCommandClaim(),
      targetCommandClaim: createTargetCommandClaim(),
      lifecycleFallback: {
        isActive: (deviceId) => this.lifecycleFallback.isActive(deviceId),
        getOwnedTargetPending: (deviceId) => this.lifecycleFallback.getOwnedTargetPending(deviceId),
      },
      isAuthorityCurrent: () => true,
      recordShedActuation: (deviceId, name, now) => this.recordShedActuation(deviceId, name, now),
      recordReleaseShedActuation: (deviceId, name, now) => this.recordReleaseShedActuation(deviceId, name, now),
      recordRestoreActuation: (deviceId, name, now) => this.recordRestoreActuation(deviceId, name, now),
      recordActivationAttemptStarted: (deviceId, name, now) => recordActivationAttemptStarted(
        state, deps.deviceDiagnostics, deviceId, name, now,
      ),
    };
    this.lifecycleFallback = new LifecycleFallbackDispatcher(this.ctx);
    this.storage = deps.storageLane.kind === 'none' ? NO_STORAGE_LANE : new BatteryExecutor(
      deps.storageLane.owner,
      deps.actuator,
      deps,
      deps.getPowerTracker,
      state.actuation,
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
    this.state.restoreBackoff.noteInstability(now);
    this.state.actuation.markShed(deviceId, now);
    this.recordReleaseShedActuation(deviceId, name, now);
  }

  // Lifecycle-end release variant: skips the shed-cooldown / instability clocks because a
  // release is the smart task handing the device back to its configured shed posture, not a
  // capacity-driven shed.
  private recordReleaseShedActuation(deviceId: string, name: string, now: number): void {
    this.recordControlTimestamp(deviceId, now);
    this.deps.deviceDiagnostics?.recordControlEvent({ kind: 'pels_shed', deviceId, name, nowTs: now });
    closeActivationAttemptForShedActuation(this.state, this.deps.deviceDiagnostics, deviceId, name, now);
  }

  private recordRestoreActuation(deviceId: string, name: string, now: number): void {
    this.state.actuation.markRestore(deviceId, now);
    this.recordControlTimestamp(deviceId, now);
    this.deps.deviceDiagnostics?.recordControlEvent({ kind: 'pels_restore', deviceId, name, nowTs: now });
  }

  private recordControlTimestamp(deviceId: string, now: number): void {
    this.state.actuation.markControlled(deviceId, now);
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
      this.state.shedDecisions.noteShedReleased(deviceId);
      if (pending.logContext === 'capacity_control_off') {
        this.state.actuation.clearShed(deviceId);
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
      this.deps.persistLastControlledMs(this.state.actuation.lastDeviceControlledMs);
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
      isExternalOffHeld: (deviceId) => this.state.isExternalOffHeld(deviceId),
      hasStorageDrift: (device) => this.storage.hasDrift(device),
      hasStorageReleaseDrift: (intent) => this.storage.hasReleaseDrift(intent),
    };
  }

  private resolveCommandState(
    deviceId: string,
    pendingBinary: PendingBinaryCommand | undefined,
  ): ReturnType<DriftObservationDeps['getCommandState']> {
    return {
      binary: pendingBinary
        ? { kind: 'pending', desired: pendingBinary.desired }
        : { kind: 'none' },
      step: this.deps.getSteppedLoadCommandSession(deviceId).stepCommandPending
        ? { kind: 'pending' }
        : { kind: 'none' },
    };
  }

  /**
   * Live read only: never settles stores, schedules work, or issues commands. An
   * expired pending command reads as none here and is left for the settle sweep
   * to expire, so a settings-UI read cannot run the command lifecycle.
   */
  public getDeviceExecutionStates(plan: DevicePlan): ReadonlyMap<string, DeviceExecutionState> {
    const reads = this.driftObservationDeps();
    const intents = buildExecutablePlan(plan).devices;
    return new Map(plan.devices.map((device, index) => {
      const live = readExecutorDevice(this.deps, device.id);
      const observed = live ? buildExecutableObservedDeviceState(live, live.steppedLoadProfile) : undefined;
      const execution = resolveDeviceExecutionState(intents[index]!, observed, {
        ...this.resolveCommandState(device.id, this.deps.pendingBinaryCommandStore.peekActive(device.id)),
        target: this.state.pendingTargetCommands[device.id] ?? null,
      }, reads.isExternalOffHeld(device.id));
      return [device.id, {
        ...execution,
        ...(live && hasObservedMeasuredPower(live) ? { currentDrawKw: live.measuredPowerKw } : {}),
      }];
    }));
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
   */
  public hasStablePlanActuation(plan: DevicePlan): boolean {
    return plan.devices.some((dev) => {
      if (hasStableUncontrolledRestoreActuation(dev, this.state) || hasStableBinaryReleaseActuation(dev)) return true;
      const stepped = buildExecutableSteppedLoadIntent(dev);
      return hasStableSteppedLoadStepActuation(dev, stepped, this.deps.getSteppedLoadCommandSession(dev.id))
        || hasStableSteppedLoadBinaryRestoreActuation(dev, stepped);
    });
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    await this.shortfallExecutor.handleShortfall(deficitKw);
  }

  public async handleShortfallCleared(): Promise<void> {
    await this.shortfallExecutor.handleShortfallCleared();
  }

  public async applyPlanActions(plan: DevicePlan): Promise<PlanActuationResult> {
    if (!plan || !Array.isArray(plan.devices)) {
      return { deviceWriteCount: 0, commandRequestCount: 0, deviceApplyFailureCount: 0 };
    }

    this.nonCapacityHoldShedIds = new Set(
      plan.devices.filter((device) => device.nonCapacityHoldShed === true).map((device) => device.id),
    );
    this.controlPersistenceBatchDepth += 1;
    try {
      return await dispatchPlanActions(this.ctx, plan, readExecutorDevices(this.deps), this.storage);
    } finally {
      this.controlPersistenceBatchDepth = Math.max(0, this.controlPersistenceBatchDepth - 1);
      this.flushLastControlledPersistence();
    }
  }
}
