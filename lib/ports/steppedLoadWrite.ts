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

/**
 * Whether the request was issued, and over which channel. Acceptance only:
 * the device's reported step reaches the executor through the observer.
 */
export type SteppedLoadStepRequestResult =
  | { requested: false }
  | { requested: true; acknowledged: true; transport: SteppedLoadStepRequestTransport }
  | { requested: true; acknowledged: false; transport: 'flow'; reasonCode: 'flow_trigger_timeout' };
