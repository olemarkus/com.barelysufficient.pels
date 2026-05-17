import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { resolveKwhPerUnitProvenanceRows, type DeadlineLabels } from '../../../shared-domain/src/deadlineLabels.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../shared-domain/src/objectiveProfileBootstrap.ts';
import { resolveLowestActiveStepKw, type resolveProfile } from './deadlinePlanResolvers.ts';
import type { DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

const formatAcceptedAt = (ms: number): string => {
  const date = new Date(ms);
  // Locale-aware short timestamp. Browser-side, so the user's runtime locale
  // and timezone are applied automatically — no `timeZone` plumbing required.
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

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

// Producer-side resolver: collapses the per-unit-rate provenance branching
// (bootstrap-source EV vs learned profile vs legacy null-source revisions)
// into a flat `{ rateMean, usingBootstrap }` payload so `buildPlanInputs`
// never has to branch on `kwhPerUnitSource` or `objectiveKind` directly.
//
// Per `feedback_layering_resolution_in_producer.md` — the producing layer
// resolves to flat values; consumers never branch on provenance / source.
//
// EV bootstrap fallback: when the latest revision came from the bootstrap
// kWh/% rate (recorder set `kwhPerUnitSource === 'bootstrap'` because no
// learned profile existed yet), the displayed rate must be the bootstrap
// constant rather than the absent profile mean. Thermal kinds never ship a
// bootstrap rate (they sit pending until a learned profile lands), so the
// bootstrap branch is EV-only.
export const resolveKwhPerUnitDisplayRate = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  profile: ReturnType<typeof resolveProfile>;
  objectiveKind: DeferredObjectiveSettingsEntry['kind'];
}): { rateMean: number | null; usingBootstrap: boolean } => {
  const usingBootstrap = params.latest.kwhPerUnitSource === 'bootstrap'
    && params.objectiveKind === 'ev_soc';
  if (usingBootstrap) {
    return { rateMean: BOOTSTRAP_EV_SOC_KWH_PER_PERCENT, usingBootstrap: true };
  }
  const learnedMean = params.profile?.kwhPerUnit?.mean;
  return {
    rateMean: typeof learnedMean === 'number' && Number.isFinite(learnedMean) ? learnedMean : null,
    usingBootstrap: false,
  };
};

export const buildPlanInputs = (params: {
  labels: DeadlineLabels;
  device: TargetDeviceSnapshot;
  provenance: DeferredObjectiveKwhPerUnitProvenanceV1 | undefined;
  // Pre-resolved by `resolveKwhPerUnitDisplayRate` so this producer never
  // branches on the revision's `kwhPerUnitSource` / `objectiveKind` to pick
  // between the learned profile mean and the EV bootstrap fallback.
  rateMean: number | null;
  // Whether the bootstrap fallback drove `rateMean`. Drives the "Estimated —
  // refining as PELS observes charging" note rendered next to the rate row;
  // suppressed when the rate came from the learned profile.
  usingBootstrap: boolean;
}): DeadlinePlanPayload['planInputs'] => {
  return {
    perUnitRateLabel: formatPerUnitRateLabel(params.rateMean, params.labels.perUnitRateUnit),
    perUnitRateNote: params.usingBootstrap ? params.labels.planInputsRateBootstrapNote : null,
    maxPowerLabel: formatMaxPowerLabel(resolveLowestActiveStepKw(params.device)),
    provenanceRows: resolveKwhPerUnitProvenanceRows({
      provenance: params.provenance,
      unitSuffix: params.labels.perUnitRateUnit,
      formatAcceptedAt,
    }),
  };
};
