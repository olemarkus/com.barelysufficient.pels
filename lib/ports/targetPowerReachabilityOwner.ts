import type { TargetPowerReachabilityState } from '../../packages/contracts/src/types';
import type { MarkSteppedLoadDesiredStepIssuedParams } from './steppedCommand';

/** The device owner's accepted configuration for an EV reachability probe. */
export type TargetPowerProbeConfiguration =
  | { kind: 'unconfigured' }
  | { kind: 'unproven'; profileFingerprint: string }
  | { kind: 'proven'; profileFingerprint: string; reachability: TargetPowerReachabilityState };

export type IssuedTargetPowerStepPowers = Pick<MarkSteppedLoadDesiredStepIssuedParams,
  'planningPowerW' | 'previousPlanningPowerW' | 'targetPowerProbeConfirmedMaxPowerW'>;

/** Configuration and evidence policy stay with the device owner; execution owns probe timing. */
export type TargetPowerReachabilityOwner = {
  readProbeConfiguration(deviceId: string): TargetPowerProbeConfiguration;
  observeMaximum(deviceId: string, planningPowerW: number): void;
  update(deviceId: string, reachability: TargetPowerReachabilityState): boolean;
  resolveIssuedStepPowers(command: MarkSteppedLoadDesiredStepIssuedParams): IssuedTargetPowerStepPowers;
};
