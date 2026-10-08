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
export type SteppedLoadStepRequestTransport = 'native_capability' | 'flow';

/**
 * Whether the request was issued, and over which channel. Acceptance only:
 * the device's reported step reaches the executor through the observer.
 */
export type SteppedLoadStepRequestResult =
  | { requested: false; reason?: 'flow_trigger_timeout' }
  | { requested: true; transport: SteppedLoadStepRequestTransport };
