/* eslint-disable max-lines -- executor keeps the plan actuation paths together for traceability. */
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
import {
  getPendingTargetCommandDecision,
  recordPendingTargetCommandAttempt,
} from './planTargetControl';
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

export type PlanExecutorDeps = {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
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
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type PlanActuationMode = 'plan' | 'reconcile';
type TargetCommandDispatchResult =
  | { applied: false }
  | { applied: true; attemptType: 'send' | 'retry' };

type TargetCommandPostActuationState = {
  latestObservedValueAfterActuation: unknown;
  pendingStillExists: boolean;
};

const waitForImmediateObservedState = async (): Promise<void> => {
  await Promise.resolve();
};

export class PlanExecutor {
  constructor(private deps: PlanExecutorDeps, private state: PlanEngineState) {
  }

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

  private log(...args: unknown[]): void {
    this.deps.log(...args);
  }

  private logDebug(...args: unknown[]): void {
    this.deps.logDebug(...args);
  }

  private error(...args: unknown[]): void {
    this.deps.error(...args);
  }

  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
    this.deps.updateLocalSnapshot(deviceId, updates);
  }

  private getShedBehavior(deviceId: string): { action: ShedAction; temperature: number | null } {
    return this.deps.getShedBehavior(deviceId);
  }

  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager.getSnapshot();
  }

  private async applyShedAction(dev: DevicePlan['devices'][number]): Promise<boolean> {
    if (dev.plannedState !== 'shed') return false;
    const shedAction = dev.shedAction ?? 'turn_off';
    if (shedAction === 'set_temperature') {
      await this.applyShedTemperature(dev);
      return true;
    }
    await this.applyShedOff(dev);
    return true;
  }

  private async applyShedTemperature(dev: DevicePlan['devices'][number]): Promise<void> {
    const snapshot = this.latestTargetSnapshot.find((entry) => entry.id === dev.id);
    const plan = resolveShedTemperaturePlan({
      dev,
      snapshot,
      capacityDryRun: this.capacityDryRun,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug(...args),
    });
    if (!plan) return;
    await this.applyShedTemperaturePlan(dev, plan.targetCap, plan.plannedTarget);
  }

  private async applyShedTemperaturePlan(
    dev: DevicePlan['devices'][number],
    targetCap: string,
    plannedTarget: number,
  ): Promise<void> {
    try {
      const result = await this.dispatchTargetCommand({
        deviceId: dev.id,
        name: dev.name || dev.id,
        targetCap,
        desired: plannedTarget,
        observedValue: dev.currentTarget,
        skipContext: 'shedding',
        actuationMode: 'plan',
      });
      if (!result.applied) return;
      this.log(`Capacity: set ${targetCap} for ${dev.name || dev.id} to ${plannedTarget}°C (shedding)`);
      const now = Date.now();
      this.state.lastDeviceShedMs[dev.id] = now;
      recordDiagnosticsShed({ diagnostics: this.deps.deviceDiagnostics, deviceId: dev.id, name: dev.name, nowTs: now });
      recordActivationSetbackForDevice({
        state: this.state,
        diagnostics: this.deps.deviceDiagnostics,
        deviceId: dev.id,
        name: dev.name,
        nowTs: now,
      });
      const guardShedding = this.capacityGuard?.isSheddingActive?.() === true;
      const guardHeadroom = this.capacityGuard?.getHeadroom?.();
      if (guardShedding || (typeof guardHeadroom === 'number' && guardHeadroom < 0)) {
        this.state.lastSheddingMs = now;
        this.state.lastOvershootMs = now;
      }
    } catch (error) {
      this.error(`Failed to set shed temperature for ${dev.name || dev.id} via DeviceManager`, error);
    }
  }

  private async applyShedOff(dev: DevicePlan['devices'][number]): Promise<void> {
    if (dev.currentState === 'off') return;
    const reason = dev.reason;
    const isSwap = reason ? reason.includes('swapped out for') : false;
    await this.applySheddingToDevice(dev.id, dev.name, isSwap ? reason : undefined);
  }

  private async applyRestorePower(
    dev: DevicePlan['devices'][number],
    mode: PlanActuationMode,
  ): Promise<void> {
    if (dev.plannedState !== 'keep' || dev.currentState !== 'off') return;
    const snapshot = this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (snapshot?.deviceClass === 'evcharger') {
      this.logDebug(`Capacity: evaluating EV restore for ${dev.name || dev.id} (${formatEvSnapshot(snapshot)})`);
    }
    if (!canTurnOnDevice(snapshot)) {
      const evReason = getEvRestoreBlockReason(snapshot);
      const suffix = evReason ? ` (${evReason})` : '';
      this.logDebug(`Capacity: skip restoring ${dev.name || dev.id}, cannot turn on from current snapshot${suffix}`);
      return;
    }
    const name = dev.name || dev.id;
    // Check if this device is already being restored (in-flight)
    if (this.state.pendingRestores.has(dev.id)) {
      this.logDebug(`Capacity: skip restoring ${name}, already in progress`);
      return;
    }
    // Mark as pending before async operation
    this.state.pendingRestores.add(dev.id);
    try {
      try {
        const applied = await setBinaryControl({
          state: this.state,
          deviceManager: this.deviceManager,
          updateLocalSnapshot: (deviceId, updates) => this.updateLocalSnapshot(deviceId, updates),
          log: (...args: unknown[]) => this.log(...args),
          logDebug: (...args: unknown[]) => this.logDebug(...args),
          error: (...args: unknown[]) => this.error(...args),
          deviceId: dev.id,
          name,
          desired: true,
          snapshot,
          logContext: 'capacity',
          restoreSource: this.getRestoreLogSource(dev.id),
          actuationMode: mode,
        });
        if (!applied) return;
        if (mode === 'plan') {
          this.state.lastRestoreMs = Date.now(); // Track when we restored so we can wait for power to stabilize
          this.state.lastDeviceRestoreMs[dev.id] = this.state.lastRestoreMs;
          recordDiagnosticsRestore({
            diagnostics: this.deps.deviceDiagnostics,
            deviceId: dev.id,
            name,
            nowTs: this.state.lastRestoreMs,
          });
          recordActivationAttemptStarted({
            state: this.state,
            diagnostics: this.deps.deviceDiagnostics,
            deviceId: dev.id,
            name,
            nowTs: this.state.lastRestoreMs,
          });
        }
        // Clear this device from pending swap targets if it was one
        this.state.pendingSwapTargets.delete(dev.id);
        delete this.state.pendingSwapTimestamps[dev.id];
      } catch (error) {
        this.error(`Failed to turn on ${name} via DeviceManager`, error);
      }
    } finally {
      this.state.pendingRestores.delete(dev.id);
    }
  }

  private async applyTargetUpdate(
    dev: DevicePlan['devices'][number],
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
  ): Promise<void> {
    const plan = this.getTargetUpdatePlan(dev, snapshot);
    if (!plan) return;
    await this.applyTargetUpdatePlan(dev, plan.targetCap, plan.isRestoring, mode);
  }

  private async applyUncontrolledRestore(
    dev: DevicePlan['devices'][number],
    snapshot?: TargetDeviceSnapshot,
  ): Promise<void> {
    if (dev.plannedState !== 'keep') return;
    if (dev.currentState !== 'off') return;
    const lastShed = this.state.lastDeviceShedMs[dev.id];
    if (!lastShed) return;
    const entry = snapshot ?? this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (entry?.deviceClass === 'evcharger') {
      this.logDebug(
        `Capacity control off: evaluating EV restore for ${dev.name || dev.id} `
        + `(${formatEvSnapshot(entry)})`,
      );
    }
    if (!canTurnOnDevice(entry)) return;
    const name = dev.name || dev.id;
    try {
      const applied = await setBinaryControl({
        state: this.state,
        deviceManager: this.deviceManager,
        updateLocalSnapshot: (deviceId, updates) => this.updateLocalSnapshot(deviceId, updates),
        log: (...args: unknown[]) => this.log(...args),
        logDebug: (...args: unknown[]) => this.logDebug(...args),
        error: (...args: unknown[]) => this.error(...args),
        deviceId: dev.id,
        name,
        desired: true,
        snapshot: entry,
        logContext: 'capacity_control_off',
        actuationMode: 'plan',
      });
      if (!applied) return;
      delete this.state.lastDeviceShedMs[dev.id];
    } catch (error) {
      this.error(`Failed to restore ${name} via DeviceManager`, error);
    }
  }

  private getTargetUpdatePlan(
    dev: DevicePlan['devices'][number],
    snapshot?: TargetDeviceSnapshot,
  ): { targetCap: string; isRestoring: boolean } | null {
    if (typeof dev.plannedTarget !== 'number' || dev.plannedTarget === dev.currentTarget) return null;
    const entry = snapshot ?? this.latestTargetSnapshot.find((d) => d.id === dev.id);
    const targetCap = entry?.targets?.[0]?.id;
    if (!targetCap) return null;

    // Check if this is a restoration (increasing temperature from shed state)
    const currentIsNumber = typeof dev.currentTarget === 'number';
    const shedBehavior = this.getShedBehavior(dev.id);
    const wasAtShedTemp = currentIsNumber && shedBehavior.action === 'set_temperature'
      && shedBehavior.temperature !== null && dev.currentTarget === shedBehavior.temperature;
    const isRestoring = wasAtShedTemp && dev.plannedTarget > (dev.currentTarget as number);
    return { targetCap, isRestoring };
  }

  private async applyTargetUpdatePlan(
    dev: DevicePlan['devices'][number],
    targetCap: string,
    isRestoring: boolean,
    mode: PlanActuationMode,
  ): Promise<void> {
    try {
      const result = await this.dispatchTargetCommand({
        deviceId: dev.id,
        name: dev.name || dev.id,
        targetCap,
        desired: dev.plannedTarget as number,
        observedValue: dev.currentTarget,
        skipContext: 'plan',
        actuationMode: mode,
      });
      if (!result.applied) return;
      const fromStr = dev.currentTarget === undefined || dev.currentTarget === null
        ? ''
        : `from ${dev.currentTarget} `;
      let actuationSuffix = ` (mode: ${this.operatingMode})`;
      if (mode === 'reconcile') {
        actuationSuffix = ` (reconcile after drift; mode: ${this.operatingMode})`;
      } else if (result.attemptType === 'retry') {
        actuationSuffix = ` (retry pending confirmation; mode: ${this.operatingMode})`;
      }
      this.log(`Set ${targetCap} for ${dev.name || dev.id} ${fromStr}to ${dev.plannedTarget}${actuationSuffix}`);

      // If this was a restoration from shed temperature, update lastRestoreMs
      // This ensures cooldown applies between restoring different devices
      if (isRestoring && mode === 'plan') {
        this.state.lastRestoreMs = Date.now();
        this.state.lastDeviceRestoreMs[dev.id] = this.state.lastRestoreMs;
        recordDiagnosticsRestore({
          diagnostics: this.deps.deviceDiagnostics,
          deviceId: dev.id,
          name: dev.name,
          nowTs: this.state.lastRestoreMs,
        });
        recordActivationAttemptStarted({
          state: this.state,
          diagnostics: this.deps.deviceDiagnostics,
          deviceId: dev.id,
          name: dev.name,
          nowTs: this.state.lastRestoreMs,
        });
      }
    } catch (error) {
      this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via DeviceManager`, error);
    }
  }

  public async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    if (this.capacityDryRun) return;
    const snapshotState = this.latestTargetSnapshot.find((d) => d.id === deviceId);
    if (shouldSkipShedding({
      state: this.state,
      deviceId,
      deviceName,
      snapshotState,
      logDebug: (...args: unknown[]) => this.logDebug(...args),
    })) {
      return;
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
      const applied = await this.trySetShedTemperature(deviceId, name, targetCap, shedTemp, canSetShedTemp);
      if (!applied) {
        await this.turnOffDevice(deviceId, name, reason);
      }
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
  ): Promise<boolean> {
    if (!canSetShedTemp || !targetCap || shedTemp === null) return false;
    const now = Date.now();
    try {
      const snapshot = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
      const observedValue = snapshot?.targets?.find((entry) => entry.id === targetCap)?.value;
      const result = await this.dispatchTargetCommand({
        deviceId,
        name,
        targetCap,
        desired: shedTemp,
        observedValue,
        skipContext: 'shedding',
        actuationMode: 'plan',
      });
      if (!result.applied) return true;
      this.log(`Capacity: set ${targetCap} for ${name} to ${shedTemp}°C (shedding)`);
      this.state.lastSheddingMs = now;
      this.state.lastOvershootMs = now;
      this.state.lastDeviceShedMs[deviceId] = now;
      recordDiagnosticsShed({ diagnostics: this.deps.deviceDiagnostics, deviceId, name, nowTs: now });
      recordActivationSetbackForDevice({
        state: this.state,
        diagnostics: this.deps.deviceDiagnostics,
        deviceId,
        name,
        nowTs: now,
      });
      return true;
    } catch (error) {
      this.error(`Failed to set shed temperature for ${name} via DeviceManager`, error);
      return false;
    }
  }

  private async dispatchTargetCommand(params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    observedValue?: unknown;
    skipContext: 'plan' | 'shedding' | 'overshoot';
    actuationMode: PlanActuationMode;
  }): Promise<TargetCommandDispatchResult> {
    const {
      deviceId,
      name,
      targetCap,
      desired,
      observedValue,
      skipContext,
      actuationMode,
    } = params;
    const latestObservedSnapshot = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    const latestObservedValue = latestObservedSnapshot?.targets?.find((entry) => entry.id === targetCap)?.value;
    if (Object.is(latestObservedValue, desired)) {
      this.logDebug(`Capacity: skip ${targetCap} for ${name}, already ${desired}°C in current snapshot`);
      return { applied: false };
    }

    const nowMs = Date.now();
    const decision = actuationMode === 'reconcile'
      ? { type: 'send' as const }
      : getPendingTargetCommandDecision({
        state: this.state,
        deviceId,
        capabilityId: targetCap,
        desired,
        nowMs,
      });
    if (decision.type === 'skip') {
      const remainingSec = Math.max(1, Math.ceil(decision.remainingMs / 1000));
      this.logDebug(
        `Capacity: skip ${targetCap} for ${name}, waiting ${remainingSec}s `
        + `for ${desired}°C confirmation (${skipContext})`,
      );
      return { applied: false };
    }

    await this.deviceManager.setCapability(deviceId, targetCap, desired);
    const pending = recordPendingTargetCommandAttempt({
      state: this.state,
      deviceId,
      capabilityId: targetCap,
      desired,
      nowMs,
      observedValue: latestObservedValue ?? observedValue,
    });
    const {
      latestObservedValueAfterActuation,
      pendingStillExists,
    } = await this.syncPendingTargetCommandAfterActuation({
      deviceId,
      name,
      targetCap,
      desired,
    });
    const retryDelaySec = Math.max(1, Math.ceil((pending.nextRetryAtMs - nowMs) / 1000));
    if (decision.type === 'retry' && pendingStillExists && !Object.is(latestObservedValueAfterActuation, desired)) {
      await this.logPendingTargetRetry({
        deviceId,
        name,
        targetCap,
        desired,
        retryCount: pending.retryCount,
        retryDelaySec,
        observedValue: decision.pending.lastObservedValue,
        observedSource: decision.pending.lastObservedSource,
        skipContext,
      });
    } else if (pendingStillExists) {
      this.logDebug(
        `Capacity: awaiting ${targetCap} confirmation for ${name} at ${desired}°C `
        + `(next retry in ${retryDelaySec}s)`,
      );
    }
    return {
      applied: true,
      attemptType: decision.type,
    };
  }

  private async syncPendingTargetCommandAfterActuation(params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
  }): Promise<TargetCommandPostActuationState> {
    const { deviceId, name, targetCap, desired } = params;
    await waitForImmediateObservedState();
    this.deps.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
    const latestObservedValueAfterActuation = this.getLatestObservedTargetValue(deviceId, targetCap);
    let pendingStillExists = this.hasMatchingPendingTargetCommand(deviceId, targetCap, desired);
    if (pendingStillExists && Object.is(latestObservedValueAfterActuation, desired)) {
      delete this.state.pendingTargetCommands[deviceId];
      pendingStillExists = false;
      this.deps.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
      this.logDebug(`Capacity: confirmed ${targetCap} for ${name} at ${desired}°C immediately after actuation`);
    }
    return {
      latestObservedValueAfterActuation,
      pendingStillExists,
    };
  }

  private getLatestObservedTargetValue(deviceId: string, targetCap: string): unknown {
    return this.latestTargetSnapshot
      .find((entry) => entry.id === deviceId)
      ?.targets?.find((entry) => entry.id === targetCap)
      ?.value;
  }

  private hasMatchingPendingTargetCommand(deviceId: string, targetCap: string, desired: number): boolean {
    return this.state.pendingTargetCommands[deviceId]?.capabilityId === targetCap
      && this.state.pendingTargetCommands[deviceId]?.desired === desired;
  }

  private async logPendingTargetRetry(params: {
    deviceId: string;
    name: string;
    targetCap: string;
    desired: number;
    retryCount: number;
    retryDelaySec: number;
    observedValue?: unknown;
    observedSource?: PendingTargetObservationSource;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }): Promise<void> {
    const {
      deviceId,
      name,
      targetCap,
      desired,
      retryCount,
      retryDelaySec,
      observedValue,
      observedSource,
      skipContext,
    } = params;
    this.log(
      `Target mismatch still present for ${name}; observed `
      + `${formatObservedTarget(observedValue)} `
      + `via ${observedSource ?? 'unknown'}, retrying ${targetCap} to ${desired}°C`,
    );
    this.logDebug(
      `Capacity: retried ${targetCap} for ${name} to ${desired}°C `
      + `(retry ${retryCount}, next retry in ${retryDelaySec}s)`,
    );
    try {
      await this.deps.logTargetRetryComparison?.({
        deviceId,
        name,
        targetCap,
        desired,
        observedValue,
        observedSource,
        retryCount,
        skipContext,
      });
    } catch (error) {
      this.error(`Failed to log target retry comparison for ${name}`, error);
    }
  }

  private async turnOffDevice(deviceId: string, name: string, reason?: string): Promise<void> {
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
        this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff or temperature target`);
        return;
      }
      this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff capability`);
      return;
    }
    const now = Date.now();
    try {
      const applied = await setBinaryControl({
        state: this.state,
        deviceManager: this.deviceManager,
        updateLocalSnapshot: (deviceId, updates) => this.updateLocalSnapshot(deviceId, updates),
        log: (...args: unknown[]) => this.log(...args),
        logDebug: (...args: unknown[]) => this.logDebug(...args),
        error: (...args: unknown[]) => this.error(...args),
        deviceId,
        name,
        desired: false,
        snapshot: snapshotEntry,
        logContext: 'capacity',
        reason,
        actuationMode: 'plan',
      });
      if (!applied) return;
      this.state.lastSheddingMs = now;
      this.state.lastDeviceShedMs[deviceId] = now;
      recordDiagnosticsShed({ diagnostics: this.deps.deviceDiagnostics, deviceId, name, nowTs: now });
      recordActivationSetbackForDevice({
        state: this.state,
        diagnostics: this.deps.deviceDiagnostics,
        deviceId,
        name,
        nowTs: now,
      });
    } catch (error) {
      this.error(`Failed to turn off ${name} via DeviceManager`, error);
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

  public async applyPlanActions(plan: DevicePlan, mode: PlanActuationMode = 'plan'): Promise<void> {
    if (!plan || !Array.isArray(plan.devices)) return;

    const snapshotMap = new Map(this.latestTargetSnapshot.map((entry) => [entry.id, entry]));
    const logCapacityDebug = (...args: unknown[]) => this.logDebug(...args);
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
          await this.applyUncontrolledRestore(dev, snapshot);
          await this.applyTargetUpdate(dev, snapshot, mode);
          continue;
        }
        const handledShed = await this.applyShedAction(dev);
        if (handledShed) continue;
        await this.applyRestorePower(dev, mode);
        await this.applyTargetUpdate(dev, snapshot, mode);
      } catch (error) {
        this.error(
          `Failed to apply action for ${dev.name || dev.id}; continuing with remaining devices`,
          error,
        );
      }
    }
  }

  private getRestoreLogSource(deviceId: string): 'shed_state' | 'current_plan' {
    const lastShedMs = this.state.lastDeviceShedMs[deviceId];
    if (!lastShedMs) return 'current_plan';
    const lastRestoreMs = this.state.lastDeviceRestoreMs[deviceId];
    return !lastRestoreMs || lastRestoreMs < lastShedMs ? 'shed_state' : 'current_plan';
  }
}

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}
