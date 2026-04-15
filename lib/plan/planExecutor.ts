/* eslint-disable
  max-lines,
  complexity,
  sonarjs/cognitive-complexity,
  max-statements,
  no-nested-ternary
-- executor keeps the plan actuation paths together for traceability. */
import Homey from 'homey';
import {
  normalizeTargetCapabilityValue,
} from '../utils/targetCapabilities';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
  sortSteppedLoadSteps,
} from '../utils/deviceControlProfiles';
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
  isPendingTargetCommandTemporarilyUnavailable,
  recordFailedPendingTargetCommandAttempt,
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
import { isSteppedLoadDevice, resolveSteppedKeepDesiredStepId } from './planSteppedLoad';
import { resolveSteppedLoadCommandPendingMs } from './planObservationPolicy';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

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
type TargetCommandDispatchResult =
  | { applied: false; reason: 'skipped' | 'failed' }
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

  private buildBinaryControlDeps() {
    return {
      state: this.state,
      deviceManager: this.deviceManager,
      log: this.log.bind(this),
      logDebug: this.logDebug.bind(this),
      error: this.error.bind(this),
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

  private recordShedActuation(deviceId: string, name: string, now: number): void {
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

  private recordRestoreActuation(deviceId: string, name: string, now: number): void {
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
      if (!result.applied) return { handled: true, wrote: false };
      this.deps.structuredLog?.info({
        event: 'target_command_applied',
        deviceId: dev.id,
        deviceName: dev.name || dev.id,
        capabilityId: targetCap,
        targetValue: plannedTarget,
        previousValue: dev.currentTarget ?? null,
        mode: 'plan',
        attemptType: result.attemptType,
        reasonCode: 'shedding',
      });
      const now = Date.now();
      this.recordShedActuation(dev.id, dev.name, now);
      return { handled: true, wrote: true };
    } catch (error) {
      this.error(`Failed to set shed temperature for ${dev.name || dev.id} via DeviceManager`, error);
      return { handled: true, wrote: false };
    }
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
    if (!canTurnOnDevice(snapshot)) {
      const evReason = getEvRestoreBlockReason(snapshot);
      const suffix = evReason ? ` (${evReason})` : '';
      this.logDebug(`Capacity: skip restoring ${dev.name || dev.id}, cannot turn on from current snapshot${suffix}`);
      return false;
    }
    const name = dev.name || dev.id;
    // Check if this device is already being restored (in-flight)
    if (this.state.pendingRestores.has(dev.id)) {
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
    const plan = this.getTargetUpdatePlan(dev, snapshot);
    if (!plan) return false;
    return this.applyTargetUpdatePlan(dev, plan.targetCap, plan.isRestoring, mode);
  }

  private async applyUncontrolledRestore(
    dev: DevicePlan['devices'][number],
    snapshot?: TargetDeviceSnapshot,
  ): Promise<boolean> {
    if (dev.plannedState !== 'keep') return false;
    if (dev.currentState !== 'off') return false;
    const lastShed = this.state.lastDeviceShedMs[dev.id];
    if (!lastShed) return false;
    const entry = snapshot ?? this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (entry?.deviceClass === 'evcharger') {
      this.logDebug(
        `Capacity control off: evaluating EV restore for ${dev.name || dev.id} `
        + `(${formatEvSnapshot(entry)})`,
      );
    }
    if (!canTurnOnDevice(entry)) return false;
    const name = dev.name || dev.id;
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
  ): Promise<boolean> {
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
      const name = dev.name || dev.id;
      if (!result.applied) return false;
      this.deps.structuredLog?.info({
        event: 'target_command_applied',
        deviceId: dev.id,
        deviceName: name,
        capabilityId: targetCap,
        targetValue: dev.plannedTarget as number,
        previousValue: dev.currentTarget ?? null,
        mode,
        attemptType: result.attemptType,
        reasonCode: mode === 'reconcile'
          ? 'reconcile'
          : isRestoring
            ? 'restore_from_shed'
            : result.attemptType === 'retry'
              ? 'retry_pending_confirmation'
              : 'plan_update',
        operatingMode: this.operatingMode,
      });

      // If this was a restoration from shed temperature, update lastRestoreMs
      // This ensures cooldown applies between restoring different devices
      if (isRestoring && mode === 'plan') {
        const now = Date.now();
        this.recordRestoreActuation(dev.id, dev.name, now);
        recordActivationAttemptStarted({
          state: this.state,
          diagnostics: this.deps.deviceDiagnostics,
          deviceId: dev.id,
          name: dev.name,
          nowTs: now,
        });
      }
      return true;
    } catch (error) {
      this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via DeviceManager`, error);
      return false;
    }
  }

  private async applySteppedLoadCommand(
    dev: DevicePlan['devices'][number],
    mode: PlanActuationMode,
  ): Promise<boolean> {
    if (!isSteppedLoadDevice(dev)) return false;

    const profile = dev.steppedLoadProfile;
    if (!profile) return false;

    // The planner already stamps this normalization onto dev.desiredStepId for keep intent.
    // Re-run the helper here as defense-in-depth for stale/reconstructed plan devices, and keep
    // the helper idempotent so planner/executor normalization cannot diverge.
    const desiredStepId = resolveSteppedKeepDesiredStepId(dev);

    if (!desiredStepId || desiredStepId === dev.selectedStepId) return false;

    const desiredStep = getSteppedLoadStep(profile, desiredStepId);
    if (!desiredStep) {
      this.logDebug(
        `Capacity: skip stepped-load command for ${dev.name || dev.id}, `
        + `desired step ${desiredStepId} is not in profile`,
      );
      return false;
    }

    // Safety: never issue a step-UP for a shed device. A stale desiredStepId from an intermediate
    // shed step must not become a restore command if the device has already reached or passed it.
    // When selectedStepId is unknown, default to 0 W (most conservative assumption for a shed device).
    if (dev.plannedState === 'shed') {
      const selectedStep = dev.selectedStepId ? getSteppedLoadStep(profile, dev.selectedStepId) : null;
      const selectedPowerW = selectedStep?.planningPowerW ?? 0;
      if (desiredStep.planningPowerW > selectedPowerW) {
        this.logDebug(
          `Capacity: skip step command for ${dev.name || dev.id}, shed device has upward`
          + ` desiredStepId=${desiredStepId} vs selectedStepId=${dev.selectedStepId ?? 'unknown'}`
          + ` (power ${selectedPowerW}W)`,
        );
        return false;
      }
    }

    const previousStepId = dev.selectedStepId ?? dev.lastDesiredStepId;
    if (dev.stepCommandPending && dev.lastDesiredStepId === desiredStepId) {
      this.logDebug(
        `Capacity: skip stepped-load command for ${dev.name || dev.id}, `
        + `awaiting confirmation of ${desiredStepId}`,
      );
      return false;
    }

    const triggerCard = this.deps.homey.flow?.getTriggerCard?.('desired_stepped_load_changed');
    if (!triggerCard?.trigger) {
      this.logDebug('Capacity: desired_stepped_load_changed trigger is unavailable; cannot issue stepped-load command');
      return false;
    }

    const now = Date.now();
    const planningPowerW = desiredStep.planningPowerW;
    try {
      const triggerPromise = triggerCard.trigger({
        step_id: desiredStep.id,
        planning_power_w: planningPowerW,
        previous_step_id: previousStepId ?? '',
      }, {
        deviceId: dev.id,
      });
      this.markSteppedLoadDesiredStepIssued({
        deviceId: dev.id,
        desiredStepId: desiredStep.id,
        previousStepId,
        issuedAtMs: now,
        pendingWindowMs: resolveSteppedLoadCommandPendingMs(dev.communicationModel),
      });

      const previousStep = previousStepId ? getSteppedLoadStep(profile, previousStepId) : undefined;
      const sortedStepIds = sortSteppedLoadSteps(profile.steps).map((step) => step.id);
      const desiredIndex = sortedStepIds.indexOf(desiredStep.id);
      const previousIndex = previousStep ? sortedStepIds.indexOf(previousStep.id) : -1;
      const nextDirection = previousStep && desiredIndex > previousIndex
        ? 'restore'
        : previousStep && desiredIndex < previousIndex
          ? 'shed'
          : dev.plannedState === 'shed'
            ? 'shed'
            : 'restore';
      this.deps.structuredLog?.info({
        event: 'stepped_load_command_requested',
        deviceId: dev.id,
        deviceName: dev.name || dev.id,
        previousStepId: previousStepId ?? null,
        desiredStepId: desiredStep.id,
        planningPowerW,
        direction: nextDirection,
        mode,
      });
      void Promise.resolve(triggerPromise).catch((error) => {
        this.error(`Failed to trigger stepped-load command for ${dev.name || dev.id}`, error);
      });
      if (mode !== 'plan') return false;
      if (nextDirection === 'shed') {
        this.recordShedActuation(dev.id, dev.name, now);
        return false;
      }
      this.recordRestoreActuation(dev.id, dev.name, now);
      recordActivationAttemptStarted({
        state: this.state,
        diagnostics: this.deps.deviceDiagnostics,
        deviceId: dev.id,
        name: dev.name,
        nowTs: now,
        source: 'tracked_step_up',
      });
      return false;
    } catch (error) {
      this.error(`Failed to trigger stepped-load command for ${dev.name || dev.id}`, error);
      return false;
    }
  }

  /**
   * Reconcile a stepped device back to on when it has `keep` intent but is
   * currently off. This covers both:
   * 1. Dual-control inconsistency: step at non-zero but onoff=false
   * 2. Genuinely off: step at off-step and onoff=false
   *
   * For `keep` intent, we always need onoff=true AND step non-zero. Any violation
   * should trigger restore.
   */
  private async applySteppedLoadRestore(
    dev: DevicePlan['devices'][number],
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
    anyShedDevices: boolean,
  ): Promise<boolean> {
    const name = dev.name || dev.id;

    if (dev.plannedState !== 'keep') {
      this.logDebug(`Capacity: skip stepped-load restore for ${name}, plannedState is ${dev.plannedState}`);
      return false;
    }
    if (dev.currentState !== 'off') {
      this.logDebug(`Capacity: skip stepped-load restore for ${name}, currentState is ${dev.currentState}`);
      return false;
    }

    const isAtOffStep = dev.steppedLoadProfile && dev.selectedStepId
      && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId);
    const onoffViolated = snapshot?.currentOn === false;
    // Only treat step as violated when a step-up is actually planned — i.e. the
    // desired step differs from the selected step and targets a non-off step.
    // Without this gate the method would repeatedly attempt binary restore
    // without addressing the underlying step violation.
    const desiredIsNonOff = dev.desiredStepId
      && dev.steppedLoadProfile
      && !isSteppedLoadOffStep(dev.steppedLoadProfile, dev.desiredStepId);
    const stepViolated = Boolean(
      isAtOffStep
      && desiredIsNonOff
      && dev.desiredStepId !== dev.selectedStepId,
    );

    if (onoffViolated) {
      this.logDebug(`Capacity: ${name} violates keep invariant: onoff=${snapshot?.currentOn}`);
    }
    if (stepViolated) {
      this.logDebug(`Capacity: ${name} violates keep invariant: step=${dev.selectedStepId} (off-step)`);
    }

    if (!onoffViolated && !stepViolated) {
      this.logDebug(`Capacity: skip stepped-load restore for ${name}, no keep violations detected`);
      return false;
    }

    if (this.applyKeepInvariantShedBlock(dev, name, anyShedDevices)) return false;
    // Block condition no longer applies — clear dedupe state so next block re-emits
    delete this.state.keepInvariantShedBlockedByDevice[dev.id];

    if (!snapshot) {
      this.logDebug(`Capacity: skip stepped-load restore for ${name}, no snapshot available`);
      return false;
    }
    if (!canTurnOnDevice(snapshot)) {
      this.logDebug(
        `Capacity: skip stepped-load restore for ${name}, cannot turn on from current snapshot`,
      );
      return false;
    }
    if (this.state.pendingRestores.has(dev.id)) {
      this.logDebug(`Capacity: skip stepped-load restore for ${name}, already in progress`);
      return false;
    }
    if (!onoffViolated) {
      return true;
    }
    this.state.pendingRestores.add(dev.id);
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
        event: 'restore_keep_invariant_enforced',
        deviceId: dev.id,
        deviceName: name,
        mode,
        onoffViolated,
        stepViolated,
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
      return true;
    } catch (error) {
      this.error(`Failed to restore stepped-load device ${name} via binary control`, error);
      return false;
    } finally {
      this.state.pendingRestores.delete(dev.id);
    }
  }

  /**
   * Returns true (and records dedupe state) if the shed invariant blocks a stepped-load
   * binary restore for this device. Emits a debug event only on transitions.
   */
  private applyKeepInvariantShedBlock(
    dev: DevicePlan['devices'][number],
    name: string,
    anyShedDevices: boolean,
  ): boolean {
    if (!anyShedDevices || !dev.steppedLoadProfile || !dev.desiredStepId) return false;
    const lowestNonZeroStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
    const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, dev.desiredStepId);
    if (!lowestNonZeroStep || !desiredStep || desiredStep.planningPowerW <= lowestNonZeroStep.planningPowerW) {
      return false;
    }
    this.logDebug(`Capacity: skip stepped-load restore for ${name}, shed invariant: `
      + `desiredStep=${dev.desiredStepId} exceeds lowestNonZeroStep=${lowestNonZeroStep.id}`);
    const prevBlock = this.state.keepInvariantShedBlockedByDevice[dev.id];
    const unchanged = prevBlock !== undefined
      && prevBlock.desiredStepId === dev.desiredStepId
      && prevBlock.lowestNonZeroStepId === lowestNonZeroStep.id;
    if (!unchanged) {
      this.deps.debugStructured?.({
        event: 'restore_keep_invariant_shed_blocked',
        deviceId: dev.id,
        deviceName: name,
        desiredStepId: dev.desiredStepId,
        lowestNonZeroStepId: lowestNonZeroStep.id,
        rejectionReason: 'shed_invariant',
      });
      this.state.keepInvariantShedBlockedByDevice[dev.id] = {
        desiredStepId: dev.desiredStepId,
        lowestNonZeroStepId: lowestNonZeroStep.id,
      };
    }
    return true;
  }

  /**
   * For a stepped device with `shed` intent, send `onoff=false` when appropriate:
   * - For `turn_off` shed action: binary off fires immediately (not waiting for off-step).
   * - For any shed device that has already reached the off-step: also fire binary off
   *   as a finalization step (covers the `set_step` path once it steps down to zero).
   * `setBinaryControl` has its own "already off" guard, so duplicate calls are safe.
   */
  private async applySteppedLoadShedOff(
    dev: DevicePlan['devices'][number],
    snapshot: TargetDeviceSnapshot | undefined,
    mode: PlanActuationMode,
  ): Promise<boolean> {
    if (dev.plannedState !== 'shed') return false;
    const atOffStep = dev.steppedLoadProfile && dev.selectedStepId
      && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId);
    if (dev.shedAction !== 'turn_off' && !atOffStep) return false;
    if (!snapshot) return false;
    const name = dev.name || dev.id;
    try {
      const applied = await setBinaryControl({
        ...this.buildBinaryControlDeps(),
        deviceId: dev.id,
        name,
        desired: false,
        snapshot,
        logContext: 'capacity',
        actuationMode: mode,
      });
      if (!applied) return false;
      this.deps.structuredLog?.info({
        event: 'binary_command_applied',
        deviceId: dev.id,
        deviceName: name,
        capabilityId: snapshot.controlCapabilityId ?? 'onoff',
        desired: false,
        mode,
        reasonCode: mode === 'reconcile' ? 'reconcile_shed' : 'stepped_turn_off_shed',
      });
      return true;
    } catch (error) {
      this.error(`Failed to turn off stepped-load device ${name} via binary control`, error);
      return false;
    }
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
    if (!canSetShedTemp || !targetCap || shedTemp === null) return { handled: false, wrote: false };
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
      if (!result.applied) return { handled: result.reason === 'skipped', wrote: false };
      this.deps.structuredLog?.info({
        event: 'target_command_applied',
        deviceId,
        deviceName: name,
        capabilityId: targetCap,
        targetValue: shedTemp,
        previousValue: observedValue ?? null,
        mode: 'plan',
        attemptType: result.attemptType,
        reasonCode: 'shedding',
      });
      this.recordShedActuation(deviceId, name, now);
      return { handled: true, wrote: true };
    } catch (error) {
      this.error(`Failed to set shed temperature for ${name} via DeviceManager`, error);
      return { handled: false, wrote: false };
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
      desired: rawDesired,
      observedValue,
      skipContext,
      actuationMode,
    } = params;
    const latestObservedSnapshot = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    const target = latestObservedSnapshot?.targets?.find((entry) => entry.id === targetCap);
    const desired = normalizeTargetCapabilityValue({ target, value: rawDesired });
    const latestObservedValue = latestObservedSnapshot?.targets?.find((entry) => entry.id === targetCap)?.value;
    if (Object.is(latestObservedValue, desired)) {
      this.logDebug(`Capacity: skip ${targetCap} for ${name}, already ${desired}°C in current snapshot`);
      return { applied: false, reason: 'skipped' };
    }

    const nowMs = Date.now();
    const pendingBeforeDecision = this.state.pendingTargetCommands[deviceId];
    const canBypassRetryState = actuationMode === 'reconcile'
      && !isPendingTargetCommandTemporarilyUnavailable(pendingBeforeDecision);
    const decision = canBypassRetryState
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
      if (decision.pending.status === 'temporary_unavailable') {
        this.logDebug(
          `Capacity: skip ${targetCap} for ${name}, device temporarily unavailable `
          + `for ${remainingSec}s before retry (${skipContext})`,
        );
      } else {
        this.logDebug(
          `Capacity: skip ${targetCap} for ${name}, waiting ${remainingSec}s `
          + `for ${desired}°C confirmation (${skipContext})`,
        );
      }
      return { applied: false, reason: 'skipped' };
    }

    try {
      await this.deviceManager.setCapability(deviceId, targetCap, desired);
    } catch (error) {
      const failedPending = recordFailedPendingTargetCommandAttempt({
        state: this.state,
        deviceId,
        capabilityId: targetCap,
        desired,
        nowMs,
        observedValue: latestObservedValue ?? observedValue,
      });
      const retryDelaySec = Math.max(1, Math.ceil((failedPending.nextRetryAtMs - nowMs) / 1000));
      this.log(
        `Failed to set ${targetCap} for ${name}; treating device as temporarily unavailable `
        + `for ${retryDelaySec}s before retry`,
      );
      this.error(`Failed to set ${targetCap} for ${name} via DeviceManager`, error);
      return { applied: false, reason: 'failed' };
    }
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
        this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff or temperature target`);
        return false;
      }
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
          const stepRestoreReady = await this.applySteppedLoadRestore(dev, snapshot, mode, anyShedDevices);
          if (stepRestoreReady) await this.applySteppedLoadCommand(dev, mode);
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

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}
