import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import {
  formatSmartTaskExtraPermissionsValue,
  resolveKwhPerUnitProvenanceRows,
  SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE,
  type DeadlineLabels,
} from '../../../shared-domain/src/deadlineLabels.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../../../shared-domain/src/objectiveProfileBootstrap.ts';
import { formatAcceptedAt } from './deadlinePlanFormatters.ts';
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

const formatMaxPowerLabel = (kw: number | null): string | null => {
  if (kw === null) return null;
  if (kw < 2) return `${kw.toFixed(2).replace(/\.?0+$/, '')} kW`;
  return `${kw.toFixed(1)} kW`;
};

const resolvePlanInputPowerKw = (params: {
  planningSpeedKw: number | null;
  device: TargetDeviceSnapshot;
}): number | null => params.planningSpeedKw ?? resolveLowestActiveStepKw(params.device);

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
  objective: DeferredObjectiveSettingsEntry;
  planningSpeedKw: number | null;
  nowMs: number;
}): DeadlinePlanPayload['planInputs'] => {
  return {
    perUnitRateLabel: formatPerUnitRateLabel(params.rateMean, params.labels.perUnitRateUnit),
    perUnitRateNote: params.usingBootstrap ? params.labels.planInputsRateBootstrapNote : null,
    maxPowerLabel: formatMaxPowerLabel(resolvePlanInputPowerKw({
      planningSpeedKw: params.planningSpeedKw,
      device: params.device,
    })),
    maxPowerNote: params.objective.rescue?.limitLowerPriorityDevices
      ? SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE
      : null,
    extraPermissionsValue: formatSmartTaskExtraPermissionsValue(params.objective.rescue),
    provenanceRows: resolveKwhPerUnitProvenanceRows({
      provenance: params.provenance,
      nowMs: params.nowMs,
      formatAcceptedAt,
    }),
  };
};
