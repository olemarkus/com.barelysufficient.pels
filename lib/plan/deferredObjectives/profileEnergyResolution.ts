import type { PowerTrackerState } from '../../core/powerTracker';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../packages/shared-domain/src/objectiveProfileBootstrap';
import type { DeferredObjectiveKind } from './types';

export type DeferredObjectiveKwhPerUnitSource = 'learned' | 'bootstrap';

export type DeferredObjectiveEnergyResolution = {
  energyNeededKWh: number;
  kWhPerUnit: number | null;
  rateConfidence: string | null;
  // null when the resolution did not consult a profile, e.g. when the target
  // is already satisfied and we short-circuit `energyNeededKWh` to zero.
  kwhPerUnitSource: DeferredObjectiveKwhPerUnitSource | null;
  reasonCode: null;
} | {
  energyNeededKWh: null;
  kWhPerUnit: null;
  rateConfidence: null;
  kwhPerUnitSource: null;
  reasonCode: 'objective_missing_capacity';
};

export const resolveProfileEnergy = (params: {
  powerTracker: PowerTrackerState;
  deviceId: string;
  objectiveKind: DeferredObjectiveKind;
  remainingUnits: number;
}): DeferredObjectiveEnergyResolution => {
  const profile = params.powerTracker.objectiveProfiles?.[params.deviceId];
  const kWhPerUnit = profile?.kind === params.objectiveKind ? profile.kwhPerUnit : undefined;
  if (kWhPerUnit && Number.isFinite(kWhPerUnit.mean) && kWhPerUnit.mean > 0) {
    return {
      energyNeededKWh: params.remainingUnits * kWhPerUnit.mean,
      kWhPerUnit: kWhPerUnit.mean,
      rateConfidence: kWhPerUnit.confidence,
      kwhPerUnitSource: 'learned',
      reasonCode: null,
    };
  }
  // Bootstrap fallback for EV SoC objectives: SoC reporting depends on a
  // plugged-in charge session, so a learned `kwhPerUnit` often isn't available
  // when the user first sets a deadline. Use a conservative-high default so
  // the planner can produce a useful allocation immediately; the very next
  // accepted profile sample takes over and an automatic `rate_refined`
  // revision is written when the allocation shifts.
  if (params.objectiveKind === 'ev_soc') {
    return {
      energyNeededKWh: params.remainingUnits * BOOTSTRAP_EV_SOC_KWH_PER_PERCENT,
      kWhPerUnit: BOOTSTRAP_EV_SOC_KWH_PER_PERCENT,
      rateConfidence: null,
      kwhPerUnitSource: 'bootstrap',
      reasonCode: null,
    };
  }
  return {
    energyNeededKWh: null,
    kWhPerUnit: null,
    rateConfidence: null,
    kwhPerUnitSource: null,
    reasonCode: 'objective_missing_capacity',
  };
};
