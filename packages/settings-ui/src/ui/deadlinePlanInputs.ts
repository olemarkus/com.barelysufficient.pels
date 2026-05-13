import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { DeadlineLabels } from '../../../shared-domain/src/deadlineLabels.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type { DeferredObjectiveActivePlanRevisionV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../shared-domain/src/objectiveProfileBootstrap.ts';
import { resolveLowestActiveStepKw, type resolveProfile } from './deadlinePlanResolvers.ts';
import type { DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

const formatPerUnitRateLabel = (
  kwhPerUnitMean: number | null | undefined,
  unitSuffix: DeadlineLabels['perUnitRateUnit'],
): string | null => {
  if (typeof kwhPerUnitMean !== 'number' || !Number.isFinite(kwhPerUnitMean) || kwhPerUnitMean <= 0) {
    return null;
  }
  return `${kwhPerUnitMean.toFixed(2)} ${unitSuffix}`;
};

const formatMaxPowerLabel = (lowestStepKw: number | null): string | null => (
  lowestStepKw === null ? null : `${lowestStepKw.toFixed(1)} kW`
);

export const buildPlanInputs = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  profile: ReturnType<typeof resolveProfile>;
  labels: DeadlineLabels;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
  device: TargetDeviceSnapshot;
}): DeadlinePlanPayload['planInputs'] => {
  // When the latest revision came from the bootstrap fallback (no learned
  // kwhPerUnit yet), show the bootstrap value rather than the absent profile
  // mean so the rate row is populated. Default-source revisions and
  // legacy persisted revisions (no source field) fall back to the profile.
  const usingBootstrap = params.latest.kwhPerUnitSource === 'bootstrap'
    && params.objectiveKind === 'ev_soc';
  const rateMean = usingBootstrap
    ? BOOTSTRAP_EV_SOC_KWH_PER_PERCENT
    : params.profile?.kwhPerUnit?.mean;
  return {
    perUnitRateLabel: formatPerUnitRateLabel(rateMean, params.labels.perUnitRateUnit),
    perUnitRateNote: usingBootstrap ? params.labels.planInputsRateBootstrapNote : null,
    maxPowerLabel: formatMaxPowerLabel(resolveLowestActiveStepKw(params.device)),
  };
};
