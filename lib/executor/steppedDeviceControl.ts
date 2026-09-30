import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import {
  getSteppedLoadLowestActiveStep, getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import type { Loggers } from '../logging/logger';
import type { FlowSteppedLoadAdmission } from '../ports/flowSteppedLoadAdmission';
import type { MarkSteppedLoadDesiredStepIssuedParams } from '../ports/steppedCommand';
import { readExecutorDevice, type ExecutorDeviceReadDeps } from './executorDeviceRead';
import type { SteppedCommandStore } from './steppedCommandStore';
import type { SteppedReportedStepStore } from '../observer/steppedReportedStep';
import type { ReportSteppedLoadActualStepResult } from './steppedCommandState';
import { emitSteppedFeedbackLog, resolvePlannedDesiredStepToPreserve } from './steppedFeedback';
import type { TargetPowerCommandLifecycle } from './targetPowerCommandLifecycle';

/** Stepped-command lifecycle over owner-resolved configuration and admitted observations. */
export class SteppedDeviceControl {
  constructor(
    private readonly store: SteppedCommandStore,
    private readonly reportedStore: SteppedReportedStepStore,
    private readonly source: ExecutorDeviceReadDeps,
    private readonly targetPower: TargetPowerCommandLifecycle,
    private readonly admitFlowReport: (
      deviceId: string, stepId: string, powerW: number | undefined,
    ) => FlowSteppedLoadAdmission,
    private readonly readPlannedStep: (deviceId: string, profile: SteppedLoadProfile) => string | undefined,
    private readonly loggers: Loggers,
  ) {}

  getSteppedLoadProfile(deviceId: string): SteppedLoadProfile | null {
    const configuration = this.source.getDeviceConfiguration(deviceId);
    return configuration && 'steppedLoadProfile' in configuration ? configuration.steppedLoadProfile : null;
  }

  getSteppedLoadCommandSession(deviceId: string) {
    const profile = this.getSteppedLoadProfile(deviceId);
    return {
      initializationAssumedStepId: this.store.peekInitializationLatch(deviceId,
        profile ? getSteppedLoadLowestActiveStep(profile)?.id : undefined),
      hasPriorStepCommand: this.store.hasPriorStepCommand(deviceId),
      reportedStepId: this.source.getObservedState(deviceId)?.reportedStepId,
      stepCommandPending: this.store.isStepCommandPending(deviceId),
    };
  }

  markSteppedLoadDesiredStepIssued(command: MarkSteppedLoadDesiredStepIssuedParams): void {
    this.targetPower.markDesiredStepIssued(command);
  }

  hasPendingTargetPowerProbe(): boolean { return this.store.hasPendingTargetPowerProbe(); }

  reconcileTargetPowerReachability(
    devices: Parameters<TargetPowerCommandLifecycle['reconcile']>[0], nowMs = Date.now(),
  ): void {
    for (const device of devices) {
      const configuration = this.source.getDeviceConfiguration(device.id);
      if (configuration) this.store.reconcileConfiguration(configuration);
    }
    this.targetPower.reconcile(devices, nowMs);
  }

  reportSteppedLoadActualStep(
    deviceId: string, stepId: string, planningPowerW?: number,
  ): ReportSteppedLoadActualStepResult {
    const previousReportedStepId = this.reportedStore.get(deviceId)?.stepId;
    const previousDesired = this.store.getDesired(deviceId);
    const admission = this.admitFlowReport(deviceId, stepId, planningPowerW);
    if (admission.kind !== 'accepted') {
      return this.ignoreReport(deviceId, stepId, admission);
    }
    const { profile, observation } = admission;
    const previousDesiredStepId = getSteppedLoadStep(profile, previousDesired?.stepId)?.id;
    const latestPlanDesiredStepId = this.readPlannedStep(deviceId, profile);
    const plannedDesiredStepId = latestPlanDesiredStepId ?? previousDesiredStepId;
    const device = readExecutorDevice(this.source, deviceId);
    if (device) this.targetPower.reconcile([device], observation.observedAtMs);
    const changed = this.store.reportActualStep(observation);
    const preserved = resolvePlannedDesiredStepToPreserve(
      previousDesired, previousDesiredStepId, latestPlanDesiredStepId, plannedDesiredStepId, observation.stepId,
    );
    if (preserved) this.store.preserveDesiredStep({ deviceId, desiredStepId: preserved,
      previousStepId: observation.stepId, status: preserved === observation.stepId ? 'success' : 'idle' });
    if (changed === 'unchanged') {
      this.loggers.debugStructured?.({ event: 'stepped_load_feedback_unchanged', deviceId, stepId });
    } else {
      emitSteppedFeedbackLog(this.loggers.structuredLog, deviceId, device ? device.name.trim() : `device ${deviceId}`,
        stepId, previousReportedStepId, previousDesired, plannedDesiredStepId);
    }
    return changed;
  }

  getRuntimeStateForTests() { return this.store.getStateForTests(); }

  private ignoreReport(
    deviceId: string, stepId: string, admission: Exclude<FlowSteppedLoadAdmission, { kind: 'accepted' }>,
  ): ReportSteppedLoadActualStepResult {
    if (admission.kind === 'native_control') this.reportedStore.clear(deviceId);
    this.loggers.debugStructured?.({ event: 'stepped_load_feedback_ignored', deviceId, stepId,
      reason: admission.kind === 'native_control' ? 'native_wiring_enabled' : admission.kind });
    return admission.kind === 'invalid' ? 'invalid' : 'unchanged';
  }
}
