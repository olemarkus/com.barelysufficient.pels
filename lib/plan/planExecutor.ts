/* eslint-disable
  max-lines,
  complexity,
  sonarjs/cognitive-complexity,
  max-statements
-- executor keeps the plan actuation paths together for traceability. */
import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import { DeviceManager } from '../core/deviceManager';
import type { DevicePlan, ShedAction } from './planTypes';
import type { PendingTargetObservationSource } from './planTypes';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import { incPerfCounter } from '../utils/perfCounters';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
  setBinaryControl,
} from './planBinaryControl';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
  recordActivationSetbackForDevice,
  recordDiagnosticsRestore,
  recordDiagnosticsShed,
  resolveShedTemperaturePlan,
  shouldSkipShedding,
  shouldSkipUnavailable,
} from './planExecutorSupport';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  applyShedTemperaturePlan,
  applyTargetUpdate,
  trySetShedTemperature,
  type PlanExecutorTargetContext,
} from './planExecutorTarget';
import {
  applySteppedLoadCommand,
  applySteppedLoadRestore,
  applySteppedLoadShedOff,
  type PlanExecutorSteppedContext,
} from './planExecutorStepped';

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

export type PlanActuationMode = 'plan' | 'reconcile';
export type PlanActuationResult = {
  deviceWriteCount: number;
};
type PlanActionHandleResult = {
  handled: boolean;
  wrote: boolean;
};

export class PlanExecutor {
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
    name: string | undefined,
    now: number,
  ): void => this.recordShedActuation(deviceId, name, now);
  private readonly boundRecordRestoreActuation = (
    deviceId: string,
    name: string | undefined,
    now: number,
  ): void => this.recordRestoreActuation(deviceId, name, now);
  private readonly boundRecordActivationAttemptStarted = (
    deviceId: string,
    name: string | undefined,
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
  private readonly boundGetDesiredSteppedLoadTrigger = () => (
    this.deps.homey.flow?.getTriggerCard?.('desired_stepped_load_changed')
  );

  private targetExecutorContext?: PlanExecutorTargetContext;
  private steppedExecutorContext?: PlanExecutorSteppedContext;

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
      log: this.log.bind(this),
      logDebug: this.logDebug.bind(this),
      error: this.error.bind(this),
      structuredLog: this.deps.structuredLog,
      debugStructured: this.deps.debugStructured,
    };
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

  private recordShedActuation(deviceId: string, name: string | undefined, now: number): void {
    this.state.lastInstabilityMs = now;
    this.state.lastDeviceShedMs[deviceId] = now;
    recordDiagnosticsShed({
      diagnostics: this.deps.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
    recordActivationSetbackForDevice({
      state: this.state,
      diagnostics: this.deps.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
  }

  private recordRestoreActuation(deviceId: string, name: string | undefined, now: number): void {
    this.state.lastRestoreMs = now;
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

  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager.getSnapshot();
  }

  private buildTargetExecutorContext(): PlanExecutorTargetContext {
    if (!this.targetExecutorContext) {
      this.targetExecutorContext = {
        state: this.state,
        deviceManager: this.deviceManager,
        getShedBehavior: this.boundGetShedBehavior,
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
        getDesiredSteppedLoadTrigger: this.boundGetDesiredSteppedLoadTrigger,
        deviceDiagnostics: this.deps.deviceDiagnostics,
      };
    }

    this.steppedExecutorContext.state = this.state;
    this.steppedExecutorContext.structuredLog = this.deps.structuredLog;
    this.steppedExecutorContext.debugStructured = this.deps.debugStructured;
    this.steppedExecutorContext.deviceDiagnostics = this.deps.deviceDiagnostics;
    return this.steppedExecutorContext;
  }

  private async applyShedAction(dev: DevicePlan['devices'][number]): Promise<PlanActionHandleResult> {
    if (dev.plannedState !== 'shed') return { handled: false, wrote: false };
    const shedAction = dev.shedAction ?? 'turn_off';
    if (shedAction === 'set_temperature') {
      return this.applyShedTemperature(dev);
    }
    return this.applyShedOff(dev);
  }

  private async applyShedTemperature(dev: DevicePlan['devices'][number]): Promise<PlanActionHandleResult> {
    const snapshot = this.latestTargetSnapshot.find((entry) => entry.id === dev.id);
    const plan = resolveShedTemperaturePlan({
      dev,
      snapshot,
      capacityDryRun: this.capacityDryRun,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug(...args),
    });
    if (!plan) return { handled: true, wrote: false };
    return this.applyShedTemperaturePlan(dev, plan.targetCap, plan.plannedTarget);
  }

  private async applyShedTemperaturePlan(
    dev: DevicePlan['devices'][number],
    targetCap: string,
    plannedTarget: number,
  ): Promise<PlanActionHandleResult> {
    return applyShedTemperaturePlan(this.buildTargetExecutorContext(), dev, targetCap, plannedTarget);
  }

  private async applyShedOff(dev: DevicePlan['devices'][number]): Promise<PlanActionHandleResult> {
    if (dev.currentState === 'off') return { handled: true, wrote: false };
    const reason = dev.reason;
    const isSwap = reason ? reason.includes('swapped out for') : false;
    return {
      handled: true,
      wrote: await this.applySheddingToDevice(dev.id, dev.name, isSwap ? reason : undefined),
    };
  }

  private async applyRestorePower(
    dev: DevicePlan['devices'][number],
    mode: PlanActuationMode,
  ): Promise<boolean> {
    if (isSteppedLoadDevice(dev)) return false;
    if (dev.plannedState !== 'keep' || dev.currentState !== 'off') return false;
    const snapshot = this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (snapshot?.deviceClass === 'evcharger') {
      this.logDebug(`Capacity: evaluating EV restore for ${dev.name || dev.id} (${formatEvSnapshot(snapshot)})`);
    }
    if (!snapshot) {
      this.deps.debugStructured?.({
        event: 'restore_command_skipped',
        reasonCode: 'missing_snapshot',
        deviceId: dev.id,
        deviceName: dev.name || dev.id,
        logContext: 'capacity',
        actuationMode: mode,
      });
      this.logDebug(`Capacity: skip restoring ${dev.name || dev.id}, no snapshot available`);
      return false;
    }
    if (!canTurnOnDevice(snapshot)) {
      const evReason = getEvRestoreBlockReason(snapshot);
      const suffix = evReason ? ` (${evReason})` : '';
      this.deps.debugStructured?.({
        event: 'restore_command_skipped',
        reasonCode: 'not_setable',
        deviceId: dev.id,
        deviceName: dev.name || dev.id,
        logContext: 'capacity',
        actuationMode: mode,
      });
      this.logDebug(`Capacity: skip restoring ${dev.name || dev.id}, cannot turn on from current snapshot${suffix}`);
      return false;
    }
    const name = dev.name || dev.id;
    // Check if this device is already being restored (in-flight)
    if (this.state.pendingRestores.has(dev.id)) {
      this.deps.debugStructured?.({
        event: 'restore_command_skipped',
        reasonCode: 'already_in_progress',
        deviceId: dev.id,
        deviceName: name,
        logContext: 'capacity',
        actuationMode: mode,
      });
      this.logDebug(`Capacity: skip restoring ${name}, already in progress`);
      return false;
    }
    // Mark as pending before async operation
    this.state.pendingRestores.add(dev.id);
    try {
      try {
        const applied = await setBinaryControl({
          ...this.buildBinaryControlDeps(),
          deviceId: dev.id,
          name,
          desired: true,
          snapshot,
          logContext: 'capacity',
          restoreSource: this.getRestoreLogSource(dev.id),
          actuationMode: mode,
        });
        if (!applied) return false;
        this.deps.structuredLog?.info({
          event: 'binary_command_applied',
          deviceId: dev.id,
          deviceName: name,
          capabilityId: snapshot?.controlCapabilityId ?? 'onoff',
          desired: true,
          mode,
          reasonCode: mode === 'reconcile' ? 'reconcile_restore' : this.getRestoreLogSource(dev.id),
        });
        if (mode === 'plan') {
          const now = Date.now();
          this.recordRestoreActuation(dev.id, name, now);
          recordActivationAttemptStarted({
            state: this.state,
            diagnostics: this.deps.deviceDiagnostics,
            deviceId: dev.id,
            name,
            nowTs: now,
          });
        } else if (mode === 'reconcile') {
          recordActivationSetbackForDevice({
            state: this.state,
            diagnostics: this.deps.deviceDiagnostics,
            deviceId: dev.id,
            name,
            nowTs: Date.now(),
          });
        }
        // Clear this device from pending swap targets if it was one
        const swapEntry = this.state.swapByDevice[dev.id];
        if (swapEntry) {
          delete swapEntry.pendingTarget;
          delete swapEntry.timestamp;
          if (!swapEntry.swappedOutFor && swapEntry.lastPlanMeasurementTs === undefined) {
            delete this.state.swapByDevice[dev.id];
          }
        }
        return true;
      } catch (error) {
        this.error(`Failed to turn on ${name} via DeviceManager`, error);
        return false;
      }
    } finally {
      this.state.pendingRestores.delete(dev.id);
    }
  }

  private async applyTargetUpdate(
    dev: DevicePlan['devices'][number],
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    return applyTargetUpdate(this.buildTargetExecutorContext(), dev, snapshot, mode);
  }

  private async applyUncontrolledRestore(
    dev: DevicePlan['devices'][number],
    snapshot?: TargetDeviceSnapshot,
  ): Promise<boolean> {
    if (dev.plannedState !== 'keep') return false;
    if (dev.currentState !== 'off') return false;
    const lastShed = this.state.lastDeviceShedMs[dev.id];
    if (!lastShed) return false;
    const name = dev.name || dev.id;
    const entry = snapshot ?? this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (entry?.deviceClass === 'evcharger') {
      this.logDebug(
        `Capacity control off: evaluating EV restore for ${name} `
        + `(${formatEvSnapshot(entry)})`,
      );
    }
    if (!entry) {
      this.deps.debugStructured?.({
        event: 'restore_command_skipped',
        reasonCode: 'missing_snapshot',
        deviceId: dev.id,
        deviceName: name,
        logContext: 'capacity_control_off',
        actuationMode: 'plan',
      });
      return false;
    }
    if (!canTurnOnDevice(entry)) {
      this.deps.debugStructured?.({
        event: 'restore_command_skipped',
        reasonCode: 'not_setable',
        deviceId: dev.id,
        deviceName: name,
        logContext: 'capacity_control_off',
        actuationMode: 'plan',
      });
      return false;
    }
    try {
      const applied = await setBinaryControl({
        ...this.buildBinaryControlDeps(),
        deviceId: dev.id,
        name,
        desired: true,
        snapshot: entry,
        logContext: 'capacity_control_off',
        actuationMode: 'plan',
      });
      if (!applied) return false;
      this.deps.structuredLog?.info({
        event: 'binary_command_applied',
        deviceId: dev.id,
        deviceName: name,
        capabilityId: entry?.controlCapabilityId ?? 'onoff',
        desired: true,
        mode: 'plan',
        reasonCode: 'capacity_control_off_restore',
      });
      delete this.state.lastDeviceShedMs[dev.id];
      return true;
    } catch (error) {
      this.error(`Failed to restore ${name} via DeviceManager`, error);
      return false;
    }
  }

  private async applySteppedLoadCommand(
    dev: DevicePlan['devices'][number],
    mode: PlanActuationMode,
    options: { recordPlanActuation?: boolean } = {},
  ): Promise<boolean> {
    return applySteppedLoadCommand(this.buildSteppedExecutorContext(), dev, mode, options);
  }

  private async applySteppedLoadRestore(
    dev: DevicePlan['devices'][number],
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
    anyShedDevices: boolean,
    options: { preRestoreStepIssued?: boolean } = {},
  ): Promise<boolean> {
    return applySteppedLoadRestore(this.buildSteppedExecutorContext(), dev, snapshot, mode, anyShedDevices, options);
  }

  private async applySteppedLoadShedOff(
    dev: DevicePlan['devices'][number],
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    return applySteppedLoadShedOff(this.buildSteppedExecutorContext(), dev, snapshot, mode);
  }

  public async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<boolean> {
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
    const name = deviceName || deviceId;
    const shedBehavior = this.getShedBehavior(deviceId);
    const targetCap = snapshotState?.targets?.[0]?.id;
    const shedTemp = shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null
      ? shedBehavior.temperature
      : null;
    const canSetShedTemp = Boolean(targetCap && shedTemp !== null);
    // Mark as pending before async operation
    this.state.pendingSheds.add(deviceId);
    try {
      const shedTemperatureResult = await this.trySetShedTemperature(
        deviceId,
        name,
        targetCap,
        shedTemp,
        canSetShedTemp,
      );
      if (!shedTemperatureResult.handled) {
        return this.turnOffDevice(deviceId, name, reason);
      }
      return shedTemperatureResult.wrote;
    } finally {
      this.state.pendingSheds.delete(deviceId);
    }
  }

  public hasStablePlanActuation(plan: DevicePlan): boolean {
    return plan.devices.some((dev) => (
      dev.controllable === false
      && dev.plannedState === 'keep'
      && dev.currentState === 'off'
      && Boolean(this.state.lastDeviceShedMs[dev.id])
    ));
  }

  private async trySetShedTemperature(
    deviceId: string,
    name: string,
    targetCap: string | undefined,
    shedTemp: number | null,
    canSetShedTemp: boolean,
  ): Promise<PlanActionHandleResult> {
    return trySetShedTemperature(
      this.buildTargetExecutorContext(),
      deviceId,
      name,
      targetCap,
      shedTemp,
      canSetShedTemp,
    );
  }

  private async turnOffDevice(deviceId: string, name: string, reason?: string): Promise<boolean> {
    const snapshotEntry = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    const controlPlan = getBinaryControlPlan(snapshotEntry);
    if (snapshotEntry?.deviceClass === 'evcharger') {
      this.logDebug(`Capacity: preparing EV shed for ${name} (${formatEvSnapshot(snapshotEntry)})`);
    }
    if (!controlPlan) {
      const hasTarget = Array.isArray(snapshotEntry?.targets) && snapshotEntry.targets.length > 0;
      const now = Date.now();
      this.state.lastDeviceShedMs[deviceId] = now;
      if (!hasTarget) {
        this.deps.debugStructured?.({
          event: 'binary_command_skipped',
          reasonCode: 'missing_control_targets',
          deviceId,
          deviceName: name,
          desired: false,
          logContext: 'capacity',
          actuationMode: 'plan',
          hasTargets: false,
          capabilityId: snapshotEntry?.controlCapabilityId ?? null,
        });
        this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff or temperature target`);
        return false;
      }
      this.deps.debugStructured?.({
        event: 'binary_command_skipped',
        reasonCode: 'missing_onoff_capability',
        deviceId,
        deviceName: name,
        desired: false,
        logContext: 'capacity',
        actuationMode: 'plan',
        hasTargets: true,
        capabilityId: snapshotEntry?.controlCapabilityId ?? null,
      });
      this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff capability`);
      return false;
    }
    const now = Date.now();
    try {
      const applied = await setBinaryControl({
        ...this.buildBinaryControlDeps(),
        deviceId,
        name,
        desired: false,
        snapshot: snapshotEntry,
        logContext: 'capacity',
        reason,
        actuationMode: 'plan',
      });
      if (!applied) return false;
      this.deps.structuredLog?.info({
        event: 'binary_command_applied',
        deviceId,
        deviceName: name,
        capabilityId: snapshotEntry?.controlCapabilityId ?? controlPlan.capabilityId,
        desired: false,
        mode: 'plan',
        reasonCode: reason ? 'shed_with_reason' : 'shedding',
      });
      this.recordShedActuation(deviceId, name, now);
      return true;
    } catch (error) {
      this.error(`Failed to turn off ${name} via DeviceManager`, error);
      return false;
    }
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

  public async applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<PlanActuationResult> {
    if (!plan || !Array.isArray(plan.devices)) return { deviceWriteCount: 0 };

    const snapshotMap = new Map(this.latestTargetSnapshot.map((entry) => [entry.id, entry]));
    const logCapacityDebug = (...args: unknown[]) => this.logDebug(...args);
    const anyShedDevices = plan.devices.some((d) => d.plannedState === 'shed');
    let deviceWriteCount = 0;
    for (const dev of plan.devices) {
      const snapshot = snapshotMap.get(dev.id);
      try {
        if (shouldSkipUnavailable({
          snapshot,
          name: dev.name || dev.id,
          operation: 'actuation',
          logDebug: logCapacityDebug,
        })) {
          continue;
        }
        if (dev.controllable === false) {
          await this.applySteppedLoadCommand(dev, mode);
          if (await this.applyUncontrolledRestore(dev, snapshot)) deviceWriteCount += 1;
          if (await this.applyTargetUpdate(dev, snapshot, mode)) deviceWriteCount += 1;
          continue;
        }
        if (isSteppedLoadDevice(dev) && dev.plannedState === 'keep' && dev.currentState === 'off') {
          const onoffViolated = snapshot?.currentOn === false;
          const preRestoreStepIssued = onoffViolated
            ? await this.applySteppedLoadCommand(dev, mode, { recordPlanActuation: false })
            : false;
          const stepRestoreReady = await this.applySteppedLoadRestore(
            dev,
            snapshot,
            mode,
            anyShedDevices,
            { preRestoreStepIssued },
          );
          if (stepRestoreReady && !onoffViolated) await this.applySteppedLoadCommand(dev, mode);
          if (stepRestoreReady && onoffViolated) deviceWriteCount += 1;
          if (await this.applyTargetUpdate(dev, snapshot, mode)) deviceWriteCount += 1;
          continue;
        }
        if (isSteppedLoadDevice(dev)) {
          await this.applySteppedLoadCommand(dev, mode);
          if (await this.applySteppedLoadShedOff(dev, snapshot, mode)) deviceWriteCount += 1;
          await this.applySteppedLoadRestore(dev, snapshot, mode, anyShedDevices);
          if (await this.applyTargetUpdate(dev, snapshot, mode)) deviceWriteCount += 1;
          continue;
        }
        const shedResult = await this.applyShedAction(dev);
        if (shedResult.handled) {
          if (shedResult.wrote) deviceWriteCount += 1;
          continue;
        }
        if (await this.applyRestorePower(dev, mode)) deviceWriteCount += 1;
        if (await this.applyTargetUpdate(dev, snapshot, mode)) deviceWriteCount += 1;
      } catch (error) {
        this.error(
          `Failed to apply action for ${dev.name || dev.id}; continuing with remaining devices`,
          error,
        );
      }
    }
    return { deviceWriteCount };
  }

  private getRestoreLogSource(deviceId: string): 'shed_state' | 'current_plan' {
    const lastShedMs = this.state.lastDeviceShedMs[deviceId];
    if (!lastShedMs) return 'current_plan';
    const lastRestoreMs = this.state.lastDeviceRestoreMs[deviceId];
    return !lastRestoreMs || lastRestoreMs < lastShedMs ? 'shed_state' : 'current_plan';
  }
}
