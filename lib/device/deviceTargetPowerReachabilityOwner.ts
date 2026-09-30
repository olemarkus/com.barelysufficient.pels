import type { TargetPowerReachabilityState } from '../../packages/contracts/src/types';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import type { MarkSteppedLoadDesiredStepIssuedParams } from '../ports/steppedCommand';
import type {
  IssuedTargetPowerStepPowers,
  TargetPowerProbeConfiguration,
  TargetPowerReachabilityOwner,
} from '../ports/targetPowerReachabilityOwner';
import {
  buildEvTargetPowerProfileFingerprint,
  buildTargetPowerReachabilityState,
  isEvTargetPowerConfig,
  resolveEvTargetPowerPlannerProfile,
  resolveValidTargetPowerReachability,
  type TargetPowerConfigWithReachability,
} from './targetPowerReachability';

/** Resolves saved EV evidence beside the device's authoritative confirmed ladder. */
export class DeviceTargetPowerReachabilityOwner implements TargetPowerReachabilityOwner {
  constructor(
    private readonly getConfig: (deviceId: string) => TargetPowerConfigWithReachability | undefined,
    private readonly getConfiguration: (deviceId: string) => DeviceConfigurationRead | undefined,
    private readonly persist: (deviceId: string, reachability: TargetPowerReachabilityState) => boolean,
  ) {}

  readProbeConfiguration(deviceId: string): TargetPowerProbeConfiguration {
    const config = this.getConfig(deviceId);
    if (!isEvTargetPowerConfig(config)) return { kind: 'unconfigured' };
    const profileFingerprint = buildEvTargetPowerProfileFingerprint(config);
    const reachability = resolveValidTargetPowerReachability(config);
    return reachability
      ? { kind: 'proven', profileFingerprint, reachability }
      : { kind: 'unproven', profileFingerprint };
  }

  observeMaximum(deviceId: string, planningPowerW: number): void {
    const config = this.getConfig(deviceId);
    if (!isEvTargetPowerConfig(config) || planningPowerW <= 0) return;
    const current = resolveValidTargetPowerReachability(config);
    if (current && current.maxReachedPowerW >= planningPowerW) return;
    const next = buildTargetPowerReachabilityState({
      config,
      maxReachedPowerW: planningPowerW,
      probeFailureCount: current?.probeFailureCount,
      nextProbeAtMs: current?.nextProbeAtMs,
    });
    if (next) this.persist(deviceId, next);
  }

  update(deviceId: string, reachability: TargetPowerReachabilityState): boolean {
    return this.persist(deviceId, reachability);
  }

  resolveIssuedStepPowers(command: MarkSteppedLoadDesiredStepIssuedParams): IssuedTargetPowerStepPowers {
    const config = this.getConfig(command.deviceId);
    const configuration = this.getConfiguration(command.deviceId);
    if (!isEvTargetPowerConfig(config) || configuration?.controlModel !== 'stepped_load') return {};
    const confirmedProfile = configuration.steppedLoadProfile;
    const profile = resolveEvTargetPowerPlannerProfile({
      config,
      confirmedProfile,
      nowMs: command.issuedAtMs ?? Date.now(),
    });
    const desiredPowerW = profile.steps.find((step) => step.id === command.desiredStepId)?.planningPowerW;
    const confirmedMaxPowerW = Math.max(...confirmedProfile.steps.map((step) => step.planningPowerW));
    return {
      planningPowerW: desiredPowerW,
      previousPlanningPowerW: profile.steps.find((step) => step.id === command.previousStepId)?.planningPowerW ?? 0,
      ...(desiredPowerW !== undefined && desiredPowerW > confirmedMaxPowerW
        ? { targetPowerProbeConfirmedMaxPowerW: confirmedMaxPowerW }
        : {}),
    };
  }
}
