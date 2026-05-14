import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import { DeviceManager } from '../core/deviceManager';
import {
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan, PlanInputDevice, ShedAction } from '../plan/planTypes';
import type { PendingTargetObservationSource } from '../plan/planTypes';
import type { TargetDeviceSnapshot } from '../utils/types';
import type {
  ExecutableBinaryIntent,
  ExecutableEvIntent,
  ExecutableObservedDeviceState,
  ExecutablePlan,
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
import { isSteppedLoadDevice, resolveSteppedKeepDesiredStepId } from '../plan/planSteppedLoad';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
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
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
} from '../planContract/planDecisionSemantics';
import {
  applyDeferredEvCommand,
  applyBinaryRestore,
  applyBinarySheddingToDevice,
  applyUncontrolledBinaryRestore,
  type PlanExecutorBinaryContext,
} from './binaryExecutor';
import {
  buildExecutableObservedDeviceState,
  buildExecutableObservedState,
  buildExecutablePlan,
  findDroppedSteppedShedIntents,
  hasExecutableShedDevices,
} from './executablePlanProjection';
import { buildExecutableSteppedLoadDevice } from './executableSteppedLoadProjection';
import {
  buildExecutableTargetCommand,
  buildExecutableTargetUpdate,
} from './executableTargetProjection';
import { isObservedOff } from '../observer/observedState';
import { getSteppedLoadStep } from '../utils/deviceControlProfiles';

export type PlanExecutorDeps = {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
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
  structuredLog?: PinoLogger;
  debugStructured?: StructuredDebugEmitter;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
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

  private readonly boundLog = (...args: unknown[]): void => this.log(...args);
  private readonly boundLogDebug = (...args: unknown[]): void => this.logDebug(...args);
  private readonly boundError = (...args: unknown[]): void => this.error(...args);
  private readonly boundGetShedBehavior = (deviceId: string) => this.getShedBehavior(deviceId);
  private readonly boundBuildBinaryControlDeps = () => this.buildBinaryControlDeps();
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
    this.getRestoreLogSource(deviceId)
  );
  private targetExecutorContext?: PlanExecutorTargetContext;
  private steppedExecutorContext?: PlanExecutorSteppedContext;
  private binaryExecutorContext?: PlanExecutorBinaryContext;

  private get deviceManager(): DeviceManager {
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

  private buildBinaryControlDeps() {
    return {
      state: this.state,
      deviceManager: this.deviceManager,
      triggerFlowBackedBinaryControlRequest: (params: {
        deviceId: string;
        name: string;
        capabilityId: 'onoff' | 'evcharger_charging';
        desired: boolean;
        logContext: 'capacity' | 'capacity_control_off';
        actuationMode: PlanActuationMode;
      }) => this.triggerFlowBackedBinaryControlRequest(params),
      log: this.log.bind(this),
      logDebug: this.logDebug.bind(this),
      error: this.error.bind(this),
      structuredLog: this.deps.structuredLog,
      debugStructured: this.deps.debugStructured,
    };
  }

  private async triggerFlowBackedBinaryControlRequest(params: {
    deviceId: string;
    name: string;
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    logContext: 'capacity' | 'capacity_control_off';
    actuationMode: PlanActuationMode;
  }): Promise<void> {
    const { deviceId, capabilityId, desired } = params;
    const triggerCardId = resolveFlowBackedBinaryTriggerCardId(capabilityId, desired);
    const triggerCard = this.deps.homey.flow?.getTriggerCard?.(triggerCardId);
    if (!triggerCard?.trigger) {
      throw new Error(`Flow trigger ${triggerCardId} is unavailable`);
    }
    await triggerCard.trigger({}, {
      deviceId,
    });
  }

  private log(...args: unknown[]): void {
    this.deps.log(...args);
  }

  private logDebug(...args: unknown[]): void {
    this.deps.logDebug(...args);
  }

  private error(...args: unknown[]): void {
    this.deps.error(...args);
  }

  private recordShedActuation(deviceId: string, name: string, now: number): void {
    this.state.lastInstabilityMs = now;
    this.recordControlTimestamp(deviceId, now);
    this.state.lastDeviceShedMs[deviceId] = now;
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
  }

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
    this.deps.structuredLog?.info({
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
      this.recordShedActuation(deviceId, liveDevice.name, now);
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
      this.error('Failed to persist device last-controlled timestamps', error as Error);
    }
  }

  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager.getSnapshot();
  }

  private buildTargetExecutorContext(): PlanExecutorTargetContext {
    if (!this.targetExecutorContext) {
      this.targetExecutorContext = {
        state: this.state,
        deviceManager: this.deviceManager,
        operatingMode: this.operatingMode,
        syncLivePlanStateAfterTargetActuation: this.deps.syncLivePlanStateAfterTargetActuation,
        logTargetRetryComparison: this.deps.logTargetRetryComparison,
        structuredLog: this.deps.structuredLog,
        debugStructured: this.deps.debugStructured,
        log: this.boundLog,
        logDebug: this.boundLogDebug,
        error: this.boundError,
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
    this.targetExecutorContext.structuredLog = this.deps.structuredLog;
    this.targetExecutorContext.debugStructured = this.deps.debugStructured;
    this.targetExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.targetExecutorContext;
  }

  private buildSteppedExecutorContext(): PlanExecutorSteppedContext {
    if (!this.steppedExecutorContext) {
      this.steppedExecutorContext = {
        state: this.state,
        logDebug: this.boundLogDebug,
        error: this.boundError,
        structuredLog: this.deps.structuredLog,
        debugStructured: this.deps.debugStructured,
        buildBinaryControlDeps: this.boundBuildBinaryControlDeps,
        markSteppedLoadDesiredStepIssued: this.boundMarkSteppedLoadDesiredStepIssued,
        recordShedActuation: this.boundRecordShedActuation,
        recordRestoreActuation: this.boundRecordRestoreActuation,
        getRestoreLogSource: this.boundGetRestoreLogSource,
        requestSteppedLoadStep: (params) => this.deviceManager.requestSteppedLoadStep(params),
        deviceDiagnostics: this.deps.deviceDiagnostics,
      };
    }

    this.steppedExecutorContext.state = this.state;
    this.steppedExecutorContext.structuredLog = this.deps.structuredLog;
    this.steppedExecutorContext.debugStructured = this.deps.debugStructured;
    this.steppedExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.steppedExecutorContext;
  }

  private buildBinaryExecutorContext(): PlanExecutorBinaryContext {
    if (!this.binaryExecutorContext) {
      this.binaryExecutorContext = {
        state: this.state,
        deviceManager: this.deviceManager,
        capacityDryRun: this.capacityDryRun,
        structuredLog: this.deps.structuredLog,
        debugStructured: this.deps.debugStructured,
        logDebug: this.boundLogDebug,
        error: this.boundError,
        buildBinaryControlDeps: this.boundBuildBinaryControlDeps,
        getRestoreLogSource: this.boundGetRestoreLogSource,
        recordShedActuation: this.boundRecordShedActuation,
        recordRestoreActuation: this.boundRecordRestoreActuation,
        deviceDiagnostics: this.deps.deviceDiagnostics,
      };
    }

    this.binaryExecutorContext.state = this.state;
    this.binaryExecutorContext.capacityDryRun = this.capacityDryRun;
    this.binaryExecutorContext.structuredLog = this.deps.structuredLog;
    this.binaryExecutorContext.debugStructured = this.deps.debugStructured;
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

  private async applyDeferredEvIntent(
    intent: ExecutableEvIntent | null,
    observed: ExecutableObservedDeviceState | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    return applyDeferredEvCommand(this.buildBinaryExecutorContext(), intent, observed, mode);
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
      this.log(
        `Capacity (dry run): would set ${command?.targetCap || 'target'} `
        + `for ${intent.name} to ${intent.desired}°C (shedding)`,
      );
      return false;
    }
    if (!command) return false;
    if (Object.is(command.observedValue, command.desired)) {
      this.logDebug(
        `Capacity: skip setting ${command.targetCap || 'target'} `
        + `for ${intent.name}, already at ${intent.desired}°C`,
      );
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
  ): Promise<boolean> {
    return action
      ? applySteppedLoadRestore(
        this.buildSteppedExecutorContext(),
        action,
        snapshot,
        mode,
        hasShedDevices,
        options,
      )
      : false;
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
        logDebug: (...args: unknown[]) => this.logDebug(...args),
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
      || hasStableEvDeadlineActuation(dev)
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

    this.log(
      `Capacity shortfall: projected hard-cap budget breach, over by `
      + `~${deficitKw.toFixed(2)}kW `
      + `(total ${totalStr}kW, `
      + `threshold ${shortfallThreshold.toFixed(2)}kW, `
      + `soft ${softLimit.toFixed(2)}kW)`,
    );

    this.state.inShortfall = true;
    this.deps.homey.settings.set('capacity_in_shortfall', true);
    incPerfCounter('settings_set.capacity_in_shortfall');

    // Trigger flow card
    const card = this.deps.homey.flow?.getTriggerCard?.('capacity_shortfall');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}).catch((err: Error) => this.error('Failed to trigger capacity_shortfall', err));
    }
  }

  public async handleShortfallCleared(): Promise<void> {
    if (!this.state.inShortfall) return; // Not in shortfall state

    this.log('Capacity shortfall resolved');
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
      const logCapacityDebug = (...args: unknown[]) => this.logDebug(...args);
      const hasShedDevices = hasExecutableShedDevices(executablePlan);
      this.logUnderspecifiedSteppedShedDevices(plan, executablePlan);
      let deviceWriteCount = 0;
      let commandRequestCount = 0;
      for (const intent of executablePlan.devices) {
        const observed = observedMap.get(intent.id);
        const snapshot = observed?.snapshot;
        try {
          if (intent.projectionError) throw intent.projectionError;
          const steppedAction = buildExecutableSteppedLoadDevice(intent.steppedLoad, observed);
          if (shouldSkipUnavailable({
            snapshot,
            name: intent.name,
            operation: 'actuation',
            logDebug: logCapacityDebug,
          })) {
            continue;
          }
          if (intent.controllable === false) {
            if (await this.applySteppedLoadCommand(steppedAction, mode, snapshot)) {
              commandRequestCount += 1;
            }
            if (await this.applyUncontrolledRestore(intent.binary, observed)) deviceWriteCount += 1;
            if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
            continue;
          }
          if (isSteppedLoadRestoreFromOff(intent.steppedLoad, steppedAction)) {
            if (steppedAction?.desired.on !== true) {
              if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
              continue;
            }
            const onoffViolated = snapshot?.currentOn === false;
            const preRestoreStepIssued = onoffViolated
              ? await this.applySteppedLoadCommand(
                steppedAction,
                mode,
                snapshot,
                { recordPlanActuation: false },
              )
              : false;
            if (preRestoreStepIssued) commandRequestCount += 1;
            const stepRestoreReady = await this.applySteppedLoadRestore(
              steppedAction,
              snapshot,
              mode,
              hasShedDevices,
              { preRestoreStepIssued },
            );
            if (
              stepRestoreReady
              && !onoffViolated
              && await this.applySteppedLoadCommand(steppedAction, mode, snapshot)
            ) commandRequestCount += 1;
            if (stepRestoreReady && onoffViolated) deviceWriteCount += 1;
            if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
            continue;
          }
          if (intent.steppedLoad) {
            if (await this.applySteppedLoadCommand(steppedAction, mode, snapshot)) {
              commandRequestCount += 1;
            }
            if (await this.applySteppedLoadShedOff(steppedAction, snapshot, mode)) {
              deviceWriteCount += 1;
            }
            await this.applySteppedLoadRestore(steppedAction, snapshot, mode, hasShedDevices);
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
          if (await this.applyDeferredEvIntent(intent.ev, observed, mode)) {
            deviceWriteCount += 1;
            continue;
          }
          if (await this.applyBinaryRestoreIntent(intent.binary, observed, mode)) deviceWriteCount += 1;
          if (await this.applyTargetIntent(intent.target, observed, mode)) deviceWriteCount += 1;
        } catch (error) {
          this.error(
            `Failed to apply action for ${intent.name}; continuing with remaining devices`,
            error,
          );
        }
      }
      return { deviceWriteCount, commandRequestCount };
    } finally {
      this.controlPersistenceBatchDepth = Math.max(0, this.controlPersistenceBatchDepth - 1);
      this.flushLastControlledPersistence();
    }
  }
  /* eslint-enable complexity, sonarjs/cognitive-complexity, max-statements, max-depth */

  private getRestoreLogSource(deviceId: string): 'shed_state' | 'current_plan' {
    const lastShedMs = this.state.lastDeviceShedMs[deviceId];
    if (!lastShedMs) return 'current_plan';
    const lastRestoreMs = this.state.lastDeviceRestoreMs[deviceId];
    return !lastRestoreMs || lastRestoreMs < lastShedMs ? 'shed_state' : 'current_plan';
  }

  private logUnderspecifiedSteppedShedDevices(plan: DevicePlan, executablePlan: ExecutablePlan): void {
    if (!this.deps.debugStructured) return;
    for (const dropped of findDroppedSteppedShedIntents(plan, executablePlan)) {
      this.deps.debugStructured({
        event: 'stepped_load_shed_intent_dropped',
        reasonCode: 'underspecified_set_step',
        ...dropped,
      });
    }
  }
}

function resolveConfirmedBinaryCommandReasonCode(
  pending: PlanEngineState['pendingBinaryCommands'][string],
): string {
  if (!pending.desired) {
    return pending.reason ? 'shed_with_reason' : 'shedding';
  }
  if (pending.logContext === 'capacity_control_off') {
    return 'capacity_control_off_restore';
  }
  if (pending.actuationMode === 'reconcile') {
    return 'reconcile_restore';
  }
  return pending.restoreSource ?? 'current_plan';
}

function hasStableUncontrolledRestoreActuation(
  dev: DevicePlan['devices'][number],
  state: PlanEngineState,
): boolean {
  return dev.controllable === false
    && dev.plannedState === 'keep'
    && isObservedOff(dev)
    && Boolean(state.lastDeviceShedMs[dev.id]);
}

function hasStableEvDeadlineActuation(dev: DevicePlan['devices'][number]): boolean {
  if (dev.binaryCommandPending === true) return false;
  if (dev.deferredEvCommandIntent === 'ev_resume') {
    return dev.evChargingState === 'plugged_in_paused';
  }
  if (dev.deferredEvCommandIntent === 'ev_pause') {
    return dev.evChargingState === 'plugged_in_charging';
  }
  return false;
}

function isSteppedLoadRestoreFromOff(
  intent: ExecutableSteppedLoadIntent | null,
  action: ExecutableSteppedLoadDevice | null,
): boolean {
  return Boolean(intent?.purpose === 'keep' && action?.current.on === false);
}

function hasStableSteppedLoadStepActuation(dev: DevicePlan['devices'][number]): boolean {
  if (!isSteppedLoadDevice(dev) || dev.plannedState !== 'keep' || !dev.steppedLoadProfile) return false;
  const desiredStepId = resolveSteppedKeepDesiredStepId(dev);
  if (!desiredStepId || !dev.selectedStepId || desiredStepId === dev.selectedStepId) return false;
  if (hasEquivalentSteppedLoadCommandHold(dev, desiredStepId)) return false;

  const selectedStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.selectedStepId);
  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  if (!selectedStep || !desiredStep) return false;
  if (desiredStep.planningPowerW < selectedStep.planningPowerW) {
    return !isObservedOff(dev)
      || !isRestoreHoldReason(dev.reason);
  }
  return desiredStep.planningPowerW > selectedStep.planningPowerW
    && allowsSteppedLoadKeepInvariantRestore(dev.reason);
}

function hasEquivalentSteppedLoadCommandHold(
  dev: DevicePlan['devices'][number],
  desiredStepId: string,
): boolean {
  const lastDesiredStepId = dev.lastDesiredStepId ?? dev.desiredStepId;
  const sameCommand = lastDesiredStepId === desiredStepId;
  if (!sameCommand) return false;
  if (dev.stepCommandPending === true) return true;
  return dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && Date.now() < dev.nextStepCommandRetryAtMs;
}

function resolveFlowBackedBinaryTriggerCardId(
  capabilityId: 'onoff' | 'evcharger_charging',
  desired: boolean,
): string {
  if (capabilityId === 'evcharger_charging') {
    return desired
      ? 'flow_backed_device_start_charging_requested'
      : 'flow_backed_device_stop_charging_requested';
  }
  return desired
    ? 'flow_backed_device_turn_on_requested'
    : 'flow_backed_device_turn_off_requested';
}

function isRestoreHoldReason(reason: DeviceReason | undefined): boolean {
  return reason ? isRestoreAdmissionHoldReason(reason) : false;
}
