import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import {
  formatSmartTaskExtraPermissionsValue,
  resolveKwhPerUnitProvenanceRows,
  SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE,
  type DeadlineLabels,
} from '../../../shared-domain/src/deadlineLabels.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type { DeferredObjectiveKwhPerUnitProvenanceV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { formatAcceptedAt } from './deadlinePlanFormatters.ts';
import { resolveLowestActiveStepKw } from './deadlinePlanResolvers.ts';
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
