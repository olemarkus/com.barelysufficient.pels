import type { ReportedStepObservedProbe } from '../../packages/contracts/src/types';
import type { Loggers } from '../logging/logger';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../observer/controlCommandConfirmation';
import type {
  TargetPowerProbeConfiguration, TargetPowerReachabilityOwner,
} from '../ports/targetPowerReachabilityOwner';
import type { MarkSteppedLoadDesiredStepIssuedParams } from '../ports/steppedCommand';
import type { SteppedCommandStore } from './steppedCommandStore';
import { resolveTargetPowerReachabilityTransition } from './targetPowerReachability';
import type { SteppedLoadDesiredRuntimeState } from './steppedCommandState';

type TargetPowerExactObservation = { planningPowerW: number; observedAtMs: number };

type IssuedTargetPowerDesired = SteppedLoadDesiredRuntimeState & {
  planningPowerW: number;
  targetPowerProbeConfirmedMaxPowerW: number;
  targetPowerProbeStartedAtMs: number;
};

const isIssuedTargetPowerProbe = (
  desired: SteppedLoadDesiredRuntimeState | undefined,
): desired is IssuedTargetPowerDesired => desired !== undefined
  && desired.planningPowerW !== undefined && desired.planningPowerW > 0
  && desired.targetPowerProbeConfirmedMaxPowerW !== undefined && desired.targetPowerProbeStartedAtMs !== undefined;

type ReachabilityDevice = Pick<import('./executorDeviceRead').ExecutorDeviceRead, 'id' | 'name'>
  & ReportedStepObservedProbe;

/** The executor joins admitted commands and exact observations; it never chooses a control profile. */
export class TargetPowerCommandLifecycle {
  constructor(
    private readonly store: SteppedCommandStore,
    private readonly owner: TargetPowerReachabilityOwner,
    private readonly scheduleSettlement: (dueAtMs: number) => void,
    private readonly loggers: Loggers,
  ) {}

  markDesiredStepIssued(command: MarkSteppedLoadDesiredStepIssuedParams): void {
    const powers = this.owner.resolveIssuedStepPowers(command);
    const { targetPowerProbeConfirmedMaxPowerW: _armsTheProbe, ...planningPowers } = powers;
    this.store.markDesiredStepIssued({
      deviceId: command.deviceId,
      desiredStepId: command.desiredStepId,
      previousStepId: command.previousStepId,
      issuedAtMs: command.issuedAtMs,
      confirmationPolicy: command.confirmationPolicy,
      ...(command.unacknowledged === true ? planningPowers : powers),
    });
    const desired = this.store.getDesired(command.deviceId);
    if (desired?.targetPowerProbeConfirmedMaxPowerW !== undefined
      && desired.targetPowerProbeStartedAtMs !== undefined) {
      this.scheduleSettlement(desired.targetPowerProbeStartedAtMs + CONTROL_COMMAND_CONFIRMATION_MS);
    }
  }

  reconcile(devices: readonly ReachabilityDevice[], nowMs: number): void {
    for (const device of devices) this.reconcileDevice(device, nowMs);
  }

  private reconcileDevice(device: ReachabilityDevice, nowMs: number): void {
    const configuration = this.owner.readProbeConfiguration(device.id);
    const desired = this.store.getDesired(device.id);
    // Acknowledged probes and unacknowledged EV writes alike carry planning watts;
    // both are retired here when the planner's ladder no longer represents them.
    if (configuration.kind === 'unconfigured') {
      if (desired?.planningPowerW !== undefined) this.store.clearCommandSession(device.id);
      return;
    }
    const evidence = device.reportedStepPowerW !== undefined && device.reportedStepObservedAtMs !== undefined
      ? { planningPowerW: device.reportedStepPowerW, observedAtMs: device.reportedStepObservedAtMs }
      : undefined;
    if (desired?.planningPowerW !== undefined) {
      const currentPowers = this.owner.resolveIssuedStepPowers({ deviceId: device.id, desiredStepId: desired.stepId,
        previousStepId: desired.previousStepId,
        issuedAtMs: desired.targetPowerProbeStartedAtMs ?? desired.lastIssuedAtMs ?? desired.changedAtMs });
      if (currentPowers.planningPowerW !== desired.planningPowerW) {
        this.store.clearCommandSession(device.id);
        return;
      }
    }
    if (isIssuedTargetPowerProbe(desired)
      && this.reconcileProbe(device, configuration, desired, evidence, nowMs)) return;
    if (evidence) this.owner.observeMaximum(device.id, evidence.planningPowerW);
  }

  private reconcileProbe(
    device: ReachabilityDevice,
    configuration: Exclude<TargetPowerProbeConfiguration, { kind: 'unconfigured' }>,
    desired: IssuedTargetPowerDesired,
    evidence: TargetPowerExactObservation | undefined,
    nowMs: number,
  ): boolean {
    const transition = resolveTargetPowerReachabilityTransition({
      profileFingerprint: configuration.profileFingerprint,
      currentReachability: configuration.kind === 'proven' ? configuration.reachability : undefined,
      command: {
        requestedPowerW: desired.planningPowerW,
        confirmedMaxPowerW: desired.targetPowerProbeConfirmedMaxPowerW,
        issuedAtMs: desired.targetPowerProbeStartedAtMs,
        settleWindowMs: CONTROL_COMMAND_CONFIRMATION_MS,
      },
      observation: evidence,
      nowMs,
    });
    if (transition.kind === 'waiting') return false;
    this.owner.update(device.id, transition.reachability);
    if (transition.kind === 'confirmed') {
      this.store.confirmDesired(device.id, desired);
      this.loggers.structuredLog?.info({ event: 'target_power_reachability_raised', deviceId: device.id,
        deviceName: device.name, requestedPowerW: desired.planningPowerW,
        maxReachedPowerW: transition.reachability.maxReachedPowerW });
    } else {
      this.store.deleteDesired(device.id);
      this.loggers.structuredLog?.warn({ event: 'target_power_step_settled_below_request', deviceId: device.id,
        deviceName: device.name, requestedStepId: desired.stepId, requestedPowerW: desired.planningPowerW,
        observedPowerW: transition.observedPowerW ?? null, ...transition.reachability });
    }
    return true;
  }

}
