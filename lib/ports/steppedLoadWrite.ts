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
