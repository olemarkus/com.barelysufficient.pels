import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

/** Transport request for setting one device's stepped-load rung. */
export type SteppedLoadWrite = {
  deviceId: string;
  profile: SteppedLoadProfile;
  desiredStepId: string;
  planningPowerW: number;
  planningCurrentA: number;
  previousStepId?: string;
};

/** Channel actually used to issue a stepped-load request. */
export type SteppedLoadStepRequestTransport = 'native_capability' | 'homey_action' | 'flow';

/** A transport failure retaining the channel and original cause for the actuator. */
export class SteppedLoadTransportError extends Error {
  constructor(readonly transport: SteppedLoadStepRequestTransport, cause: unknown) {
    super('Stepped-load transport failed', { cause });
    this.name = 'SteppedLoadTransportError';
  }
}

/** Take Homey's control of a device's watt target: `target_power_mode = homey`, and no watt target. */
export type TargetPowerControlClaimWrite = { deviceId: string };

/**
 * `claimed`: Homey accepted the claim. `refused`: the device's app rejected it.
 * `not_sent`: PELS does not step the device through its watt target.
 */
export type TargetPowerControlClaimResult =
  | { kind: 'claimed' }
  | { kind: 'refused'; errorMessage: string }
  | { kind: 'not_sent' };

/**
 * Whether the rung was issued, and over which channel. Acceptance only: the
 * device's reported step reaches the executor through the observer.
 */
export type SteppedLoadStepRequestResult =
  | { requested: false }
  | { requested: false; reason: 'flow_trigger_rejected' }
  | { requested: true; acknowledged: true; transport: SteppedLoadStepRequestTransport }
  | { requested: true; acknowledged: false; transport: 'flow'; reasonCode: 'flow_trigger_timeout' };
