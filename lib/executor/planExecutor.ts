import type Homey from 'homey';
import CapacityGuard from '../power/capacityGuard';
import type { DeviceObservation } from '../device/deviceObservation';
import type { DevicePlan, PlanInputDevice, ShedAction } from '../plan/planTypes';
import type { PendingTargetObservationSource } from '../plan/planTypes';
import type { ObservedDeviceState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

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
import type {
  ExecutableBinaryIntent,
  ExecutableObservedDeviceState,
  ExecutablePlan,
  ExecutableReleaseIntent,
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
  ExecutableTargetIntent,
  ExecutableTargetUpdate,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
import type { PlanEngineState } from '../plan/planState';
import { DEVICE_LAST_CONTROLLED_MS } from '../utils/settingsKeys';
import { incPerfCounter } from '../utils/perfCounters';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  closeActivationAttemptForShedActuation,
  recordActivationAttemptStarted,
  recordDiagnosticsRestore,
  recordDiagnosticsShed,
  shouldSkipShedding,
  shouldSkipUnavailable,
} from '../plan/planExecutorSupport';
import { getLogger } from '../logging/logger';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import type { Actuator } from '../actuator/deviceActuator';

const logger = getLogger('executor/plan');
import {
  applyShedTemperaturePlan,
  applyTargetUpdate,
  trySetShedTemperature,
  type PlanExecutorTargetContext,
} from './targetExecutor';
import {
  applySteppedLoadCommand,
  applySteppedLoadRestore,
  applySteppedLoadShedOff,
  type PlanExecutorSteppedContext,
} from './steppedLoadExecutor';
import {
  applyDeferredBinaryCommand,
  applyBinaryRestore,
  applyBinarySheddingToDevice,
  applyUncontrolledBinaryRestore,
  type PlanExecutorBinaryContext,
} from './binaryExecutor';
import { applyShedReleaseIntent } from './shedReleaseActuation';
import {
  buildExecutableObservedDeviceState,
  buildExecutableObservedState,
  buildExecutablePlan,
  findDroppedSteppedShedIntents,
  hasExecutableShedDevices,
} from './executablePlanProjection';
import {
  buildExecutableSteppedLoadDevice,
  resolveSteppedLoadCurrentFallback,
} from './executableSteppedLoadProjection';
import {
  buildExecutableTargetCommand,
  buildExecutableTargetUpdate,
} from './executableTargetProjection';
import {
  hasStableBinaryReleaseActuation,
  hasStableSteppedLoadStepActuation,
  hasStableUncontrolledRestoreActuation,
  isSteppedLoadRestoreFromOff,
  resolveConfirmedBinaryCommandReasonCode,
  resolveRestoreLogSource,
} from './planExecutorPredicates';
import { selectShedActuationRecorder } from './lifecycleReleaseRecording';

export type PlanExecutorDeps = {
  homey: Homey.App['homey'];
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
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
  }) => void;
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

export type PlanActuationResult = {
  deviceWriteCount: number;
  commandRequestCount: number;
};
type PlanActionHandleResult = {
  handled: boolean;
  wrote: boolean;
};

export class PlanExecutor {
  private lastControlledPersistenceDirty = false;
  private controlPersistenceBatchDepth = 0;

  constructor(private deps: PlanExecutorDeps, private state: PlanEngineState) {
  }

  private readonly boundGetShedBehavior = (deviceId: string) => this.getShedBehavior(deviceId);
  private readonly boundBuildBinaryControlTransport = () => this.buildBinaryControlTransport();
  private readonly boundMarkSteppedLoadDesiredStepIssued = (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
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

  private get deviceManager(): PlanExecutorDeviceTransport {
    return this.deps.deviceManager;
  }

  private get capacityGuard(): CapacityGuard | undefined {
    return this.deps.getCapacityGuard();
  }

  private get capacitySettings(): { limitKw: number; marginKw: number } {
    return this.deps.getCapacitySettings();
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
  }): void {
    this.deps.markSteppedLoadDesiredStepIssued(params);
  }

  private getShedBehavior(deviceId: string): { action: ShedAction; temperature: number | null; stepId: string | null } {
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
    if (!pending.flowBackedControl) return;

    const now = params.confirmedAtMs ?? Date.now();
    logger.info({
      event: 'binary_command_applied',
      deviceId,
      deviceName: liveDevice.name,
      capabilityId: pending.capabilityId,
      desired: pending.desired,
      mode: pending.actuationMode ?? 'plan',
      reasonCode: resolveConfirmedBinaryCommandReasonCode(pending),
    });

    if (pending.desired) {
      if (pending.logContext === 'capacity_control_off') {
        delete this.state.lastDeviceShedMs[deviceId];
        delete this.state.shedDecidedMs[deviceId];
      } else if (pending.actuationMode !== 'reconcile') {
        this.recordRestoreActuation(deviceId, liveDevice.name, now);
        recordActivationAttemptStarted({
          state: this.state,
          diagnostics: this.deps.deviceDiagnostics,
          deviceId,
          name: liveDevice.name,
          nowTs: now,
        });
      }

    } else {
      // Binary OFF confirmed (flow-backed). The lifecycle-vs-capacity recorder selection
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
      this.deps.homey.settings.set(DEVICE_LAST_CONTROLLED_MS, this.state.lastDeviceControlledMs);
      this.lastControlledPersistenceDirty = false;
    } catch (error) {
      logger.error({
        event: 'executor_plan_error',
        msg: 'Failed to persist device last-controlled timestamps',
        err: error as Error,
      });
    }
  }

  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager.getSnapshot();
  }

  private buildTargetExecutorContext(): PlanExecutorTargetContext {
    if (!this.targetExecutorContext) {
      this.targetExecutorContext = {
        state: this.state,
        getObservedState: this.deps.getObservedState,
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
        observation: this.deviceManager,
        buildBinaryControlTransport: this.boundBuildBinaryControlTransport,
        markSteppedLoadDesiredStepIssued: this.boundMarkSteppedLoadDesiredStepIssued,
        recordShedActuation: this.boundRecordShedActuation,
        recordRestoreActuation: this.boundRecordRestoreActuation,
        getRestoreLogSource: this.boundGetRestoreLogSource,
        // Route step writes through the single actuator seam; the `{ requested: false }`
        // fallback matches the absent-stepped-surface arm of SteppedLoadStepRequestResult.
        requestSteppedLoadStep: (params) => this.deps.actuator.apply({ kind: 'step', ...params })
          .then((outcome) => outcome.steppedResult ?? { requested: false as const }),
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
      };
    }

    this.binaryExecutorContext.state = this.state;
    this.binaryExecutorContext.capacityDryRun = this.capacityDryRun;
    this.binaryExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.binaryExecutorContext;
  }

  private async applyBinaryRestoreIntent(
    intent: ExecutableBinaryIntent | null,
    observed: ExecutableObservedDeviceState | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    return applyBinaryRestore(this.buildBinaryExecutorContext(), intent, observed, mode);
  }

  private async applyDeferredBinaryIntent(
    intent: ExecutableReleaseIntent | null,
    observed: ExecutableObservedDeviceState | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    return applyDeferredBinaryCommand(this.buildBinaryExecutorContext(), intent, observed, mode);
  }

  private async applyShedReleaseIntent(params: {
    intent: ExecutableReleaseIntent;
    steppedLoadIntent: ExecutableSteppedLoadIntent | null;
    observed: ExecutableObservedDeviceState | undefined;
    snapshot: TargetDeviceSnapshot | undefined;
    mode: PlanActuationMode;
  }): Promise<boolean> {
    return applyShedReleaseIntent({
      ...params,
      deps: {
        getShedBehavior: this.boundGetShedBehavior,
        buildBinaryExecutorContext: () => this.buildBinaryExecutorContext(),
        buildTargetExecutorContext: () => this.buildTargetExecutorContext(),
        buildSteppedExecutorContext: () => this.buildSteppedExecutorContext(),
        recordReleaseShedActuation: this.recordReleaseShedActuation,
      },
    });
  }

  private async applyTargetIntent(
    intent: ExecutableTargetIntent | null,
    observed: ExecutableObservedDeviceState | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    if (!intent) return false;
    const latestObserved = this.resolveLatestObservedDevice(intent.deviceId, observed);
    if (intent.purpose === 'shed_temperature') {
      return this.applyShedTemperatureIntent(intent, latestObserved);
    }
    return applyTargetUpdate(
      this.buildTargetExecutorContext(),
      this.buildTargetUpdateAction(intent, latestObserved),
      mode,
    );
  }

  private resolveLatestObservedDevice(
    deviceId: string,
    observed: ExecutableObservedDeviceState | undefined,
  ): ExecutableObservedDeviceState | undefined {
    const snapshot = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    return snapshot ? buildExecutableObservedDeviceState(snapshot) : observed;
  }

  private buildTargetUpdateAction(
    intent: ExecutableTargetIntent | null,
    observed: ExecutableObservedDeviceState | undefined,
  ): ExecutableTargetUpdate | null {
    return buildExecutableTargetUpdate(
      intent,
      observed,
      this.boundGetShedBehavior,
    );
  }

  private async applyShedTemperatureIntent(
    intent: ExecutableTargetIntent,
    observed: ExecutableObservedDeviceState | undefined,
  ): Promise<boolean> {
    const command = buildExecutableTargetCommand(intent, observed);
    if (this.capacityDryRun) {
      logger.info({ event: 'executor_plan_log', msg: `Capacity (dry run): would set ${command?.targetCap || 'target'} `
        + `for ${intent.name} to ${intent.desired}°C (shedding)` });
      return false;
    }
    if (!command) return false;
    if (Object.is(command.observedValue, command.desired)) {
      logger.debug({ event: 'executor_plan_log_debug', msg: `Capacity: skip setting ${command.targetCap || 'target'} `
        + `for ${intent.name}, already at ${intent.desired}°C` });
      return false;
    }
    const result = await applyShedTemperaturePlan(this.buildTargetExecutorContext(), command);
    return result.wrote;
  }

  private async applyUncontrolledRestore(
    intent: ExecutableBinaryIntent | null,
    observed: ExecutableObservedDeviceState | undefined,
  ): Promise<boolean> {
    return applyUncontrolledBinaryRestore(this.buildBinaryExecutorContext(), intent, observed);
  }

  private async applyBinaryShedIntent(intent: ExecutableBinaryIntent | null): Promise<boolean> {
    if (!intent || intent.kind !== 'shed') return false;
    return this.applySheddingToDevice(intent.deviceId, intent.name, intent.reason);
  }

  private async applySteppedLoadCommand(
    action: ExecutableSteppedLoadDevice | null,
    mode: PlanActuationMode,
    snapshot?: TargetDeviceSnapshot,
    options: { recordPlanActuation?: boolean } = {},
  ): Promise<boolean> {
    return action
      ? applySteppedLoadCommand(this.buildSteppedExecutorContext(), action, mode, snapshot, options)
      : false;
  }

  private async applySteppedLoadRestore(
    action: ExecutableSteppedLoadDevice | null,
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
    hasShedDevices: boolean,
    options: { preRestoreStepIssued?: boolean } = {},
  ) {
    return action
      ? applySteppedLoadRestore(
        this.buildSteppedExecutorContext(),
        action,
        snapshot,
        mode,
        hasShedDevices,
        options,
      )
      : { ready: false, wroteBinary: false };
  }

  private async applySteppedLoadShedOff(
    action: ExecutableSteppedLoadDevice | null,
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    return action
      ? applySteppedLoadShedOff(this.buildSteppedExecutorContext(), action, snapshot, mode)
      : false;
  }

  public async applySheddingToDevice(deviceId: string, deviceName: string, reason?: string): Promise<boolean> {
    try {
      if (this.capacityDryRun) return false;
      const snapshotState = this.latestTargetSnapshot.find((d) => d.id === deviceId);
      if (shouldSkipShedding({
        state: this.state,
        deviceId,
        deviceName,
        snapshotState,
      })) {
        return false;
      }
      const name = deviceName;
      const shedBehavior = this.getShedBehavior(deviceId);
      const targetCap = snapshotState?.targets?.[0]?.id;
      const shedTemp = shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null
        ? shedBehavior.temperature
        : null;
      const canSetShedTemp = Boolean(targetCap && shedTemp !== null);
      // Mark as pending before async operation
      this.state.pendingSheds.add(deviceId);
      try {
        const shedTemperatureResult = await this.trySetShedTemperature({
          deviceId,
          name,
          targetCap,
          shedTemp,
          canSetShedTemp,
        });
        if (!shedTemperatureResult.handled) {
          return applyBinarySheddingToDevice(this.buildBinaryExecutorContext(), {
            deviceId,
            deviceName: name,
            reason,
            skipPrecheck: true,
            trackPendingShed: false,
          });
        }
        return shedTemperatureResult.wrote;
      } finally {
        this.state.pendingSheds.delete(deviceId);
      }
    } finally {
      this.flushLastControlledPersistence();
    }
  }

  public hasStablePlanActuation(plan: DevicePlan): boolean {
    return plan.devices.some((dev) => (
      hasStableUncontrolledRestoreActuation(dev, this.state)
      || hasStableBinaryReleaseActuation(dev)
      || hasStableSteppedLoadStepActuation(dev)
    ));
  }

  private async trySetShedTemperature(params: {
    deviceId: string;
    name: string;
    targetCap: string | undefined;
    shedTemp: number | null;
    canSetShedTemp: boolean;
  }): Promise<PlanActionHandleResult> {
    return trySetShedTemperature(this.buildTargetExecutorContext(), params);
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    if (this.state.inShortfall) return; // Already in shortfall state

    const shortfallThreshold = this.capacityGuard
      ? this.capacityGuard.getShortfallThreshold()
      : this.capacitySettings.limitKw;
    const softLimit = this.capacityGuard ? this.capacityGuard.getSoftLimit() : this.capacitySettings.limitKw;
    const total = this.capacityGuard ? this.capacityGuard.getLastTotalPower() : null;
    const totalStr = total === null ? 'unknown' : total.toFixed(2);

    logger.info({
      event: 'executor_plan_log',
      msg: `Capacity shortfall: projected hard-cap budget breach, over by `
        + `~${deficitKw.toFixed(2)}kW `
        + `(total ${totalStr}kW, `
        + `threshold ${shortfallThreshold.toFixed(2)}kW, `
        + `soft ${softLimit.toFixed(2)}kW)`,
    });

    this.state.inShortfall = true;
    this.deps.homey.settings.set('capacity_in_shortfall', true);
    incPerfCounter('settings_set.capacity_in_shortfall');

    // Trigger flow card
    const card = this.deps.homey.flow?.getTriggerCard?.('capacity_shortfall');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}).catch((err: Error) => logger.error({
        event: 'executor_plan_error',
        msg: 'Failed to trigger capacity_shortfall',
        err,
      }));
    }
  }

  public async handleShortfallCleared(): Promise<void> {
    if (!this.state.inShortfall) return; // Not in shortfall state

    logger.info({ event: 'executor_plan_log', msg: 'Capacity shortfall resolved' });
    this.state.inShortfall = false;
    this.deps.homey.settings.set('capacity_in_shortfall', false);
    incPerfCounter('settings_set.capacity_in_shortfall');
  }

  /* eslint-disable complexity, sonarjs/cognitive-complexity, max-statements, max-depth --
   * Plan execution still dispatches across all control models in one traceable
   * loop.
   */
  public async applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<PlanActuationResult> {
    if (!plan || !Array.isArray(plan.devices)) return { deviceWriteCount: 0, commandRequestCount: 0 };

    this.controlPersistenceBatchDepth += 1;
    try {
      const executablePlan = buildExecutablePlan(plan);
      const observedState = buildExecutableObservedState(this.latestTargetSnapshot);
      const observedMap = new Map(observedState.devices.map((entry) => [entry.id, entry]));
      // Producer-resolved current state per device. The raw dispatch snapshot carries
      // no observed step (`selectedStepId` is a plan-device decoration, absent here),
      // so the effective current step/on is resolved once on the plan device and
      // supplied to the projection — keeping current-state resolution in the producer
      // layer rather than re-derived on the (desired-only) executable intent. The
      // observation stays authoritative for any field it does carry (binary on,
      // reported step, measured power).
      const steppedFallbackMap = new Map(
        plan.devices.map((device) => [device.id, resolveSteppedLoadCurrentFallback(device)]),
      );
      const hasShedDevices = hasExecutableShedDevices(plan, executablePlan);
      this.logUnderspecifiedSteppedShedDevices(plan, executablePlan, mode);
      let deviceWriteCount = 0;
      let commandRequestCount = 0;
      for (const intent of executablePlan.devices) {
        const observed = observedMap.get(intent.id);
        const snapshot = observed?.snapshot;
        try {
          if (intent.projectionError) throw intent.projectionError;
          const steppedAction = buildExecutableSteppedLoadDevice(
            intent.steppedLoad,
            observed,
            steppedFallbackMap.get(intent.id),
          );
          if (shouldSkipUnavailable({
            snapshot,
            name: intent.name,
            operation: 'actuation',
          })) {
            continue;
          }
          if (intent.controllable === false) {
            // Cap-off + deferred release is the lifecycle-end path: the deferred objective
            // was the only reason PELS was driving this device, and it just transitioned out
            // of plannable status. Fire the device's configured release posture and skip the
            // uncontrolled-restore so we don't immediately re-enable what we just released.
            if (intent.release?.kind === 'binary_release') {
              if (await this.applySteppedLoadCommand(steppedAction, mode, snapshot)) commandRequestCount += 1;
              if (await this.applyDeferredBinaryIntent(intent.release, observed, mode)) deviceWriteCount += 1;
              continue;
            }
            if (intent.release?.kind === 'shed_release') {
              if (await this.applyShedReleaseIntent({
                intent: intent.release,
                steppedLoadIntent: intent.steppedLoad,
                observed,
                snapshot,
                mode,
              })) deviceWriteCount += 1;
              continue;
            }
            if (await this.applySteppedLoadCommand(steppedAction, mode, snapshot)) commandRequestCount += 1;
            if (await this.applyUncontrolledRestore(intent.binary, observed)) deviceWriteCount += 1;
            if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
            continue;
          }
          if (isSteppedLoadRestoreFromOff(intent.steppedLoad, steppedAction)) {
            if (steppedAction?.desired.on !== true) {
              if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
              continue;
            }
            const onoffViolated = snapshot?.binaryControl?.on === false;
            const preRestoreStepIssued = onoffViolated
              ? await this.applySteppedLoadCommand(
                steppedAction,
                mode,
                snapshot,
                { recordPlanActuation: false },
              )
              : false;
            if (preRestoreStepIssued) commandRequestCount += 1;
            const stepRestore = await this.applySteppedLoadRestore(
              steppedAction,
              snapshot,
              mode,
              hasShedDevices,
              { preRestoreStepIssued },
            );
            if (
              stepRestore.ready
              && !onoffViolated
              && await this.applySteppedLoadCommand(steppedAction, mode, snapshot)
            ) commandRequestCount += 1;
            if (stepRestore.wroteBinary) deviceWriteCount += 1;
            if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
            continue;
          }
          if (intent.steppedLoad) {
            if (await this.applySteppedLoadCommand(steppedAction, mode, snapshot)) commandRequestCount += 1;
            if (await this.applySteppedLoadShedOff(steppedAction, snapshot, mode)) deviceWriteCount += 1;
            const restored = await this.applySteppedLoadRestore(steppedAction, snapshot, mode, hasShedDevices);
            if (restored.wroteBinary) deviceWriteCount += 1;
            if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
            continue;
          }
          if (intent.target?.purpose === 'shed_temperature') {
            if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
            continue;
          }
          if (intent.binary?.kind === 'shed') {
            if (await this.applyBinaryShedIntent(intent.binary)) deviceWriteCount += 1;
            continue;
          }
          if (await this.applyDeferredBinaryIntent(intent.release, observed, mode)) {
            deviceWriteCount += 1;
            continue;
          }
          if (await this.applyBinaryRestoreIntent(intent.binary, observed, mode)) deviceWriteCount += 1;
          if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
        } catch (error) {
          logger.error({
            event: 'executor_plan_error',
            msg: `Failed to apply action for ${intent.name}; continuing with remaining devices`,
            err: error,
          });
        }
      }
      return { deviceWriteCount, commandRequestCount };
    } finally {
      this.controlPersistenceBatchDepth = Math.max(0, this.controlPersistenceBatchDepth - 1);
      this.flushLastControlledPersistence();
    }
  }
  /* eslint-enable complexity, sonarjs/cognitive-complexity, max-statements, max-depth */

  private logUnderspecifiedSteppedShedDevices(plan: DevicePlan, exec: ExecutablePlan, mode: PlanActuationMode): void {
    for (const dropped of findDroppedSteppedShedIntents(plan, exec)) {
      logger.debug({
        event: 'stepped_load_shed_intent_dropped',
        reasonCode: 'underspecified_set_step',
        actuationMode: mode,
        ...dropped,
      });
    }
  }
}
