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

/** SDK acceptance and device telemetry remain distinct facts. */
export type SteppedLoadStepRequestResult =
  | { requested: false; reason?: 'flow_trigger_timeout' }
  | {
    requested: true;
    transport: SteppedLoadStepRequestTransport;
    /** Matching telemetry received during the native write; acceptance alone supplies none. */
    reportedStepId?: string;
  };
