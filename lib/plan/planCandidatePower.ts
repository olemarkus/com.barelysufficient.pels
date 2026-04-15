import { resolveCandidatePower as resolveSharedCandidatePower } from './planPowerResolution';

export type PowerCandidate = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

export function resolveCandidatePower(device: PowerCandidate): number | null {
  return resolveSharedCandidatePower(device);
}
