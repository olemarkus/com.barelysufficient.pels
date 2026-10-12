import {
  formatSmartTaskExtraPermissionsValue,
  resolveKwhPerUnitProvenanceRows,
  SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE,
  type DeadlineLabels,
} from '../../../shared-domain/src/deadlineLabels.ts';
import type { DeadlinePlanSchedule, ObjectivePayloadReady } from './deadlinePlanData.ts';
import { formatAcceptedAt } from './deadlinePlanFormatters.ts';
import { resolveDisplayRateAndSpeedMode, resolveLowestActiveStepKw } from './deadlinePlanResolvers.ts';
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

const resolvePositiveNumber = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

export const buildPlanInputs = (
  input: ObjectivePayloadReady,
  schedule: DeadlinePlanSchedule,
): DeadlinePlanPayload['planInputs'] => {
  const { device, objective, activePlan, nowMs } = input.ctx;
  const { labels } = schedule;
  // `resolveDisplayRateAndSpeedMode` (`deadlinePlanResolvers.ts`) prefers the
  // runtime producer's value (`resolveRateMean`,
  // `lib/objectives/deferredObjectives/activePlanRevisionBuild.ts`) so this producer never
  // branches on the revision's `kwhPerUnitSource` / `objectiveKind` to pick
  // between the learned profile mean and the EV bootstrap fallback.
  // `usingBootstrap` (the bootstrap fallback drove `rateMean`) drives the
  // "Estimated — refining as PELS observes charging" note next to the rate
  // row; suppressed when the rate came from the learned profile.
  const { rateMean, usingBootstrap } = resolveDisplayRateAndSpeedMode(activePlan);
  const planningSpeedKw = resolvePositiveNumber(activePlan.initialPlanningSpeedKw ?? activePlan.latest.planningSpeedKw);
  return {
    perUnitRateLabel: formatPerUnitRateLabel(rateMean, labels.perUnitRateUnit),
    perUnitRateNote: usingBootstrap ? labels.planInputsRateBootstrapNote : null,
    maxPowerLabel: formatMaxPowerLabel(planningSpeedKw ?? resolveLowestActiveStepKw(device)),
    maxPowerNote: objective.rescue?.limitLowerPriorityDevices
      ? SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE
      : null,
    extraPermissionsValue: formatSmartTaskExtraPermissionsValue(objective.rescue),
    provenanceRows: resolveKwhPerUnitProvenanceRows(
      activePlan.kwhPerUnitProvenance,
      nowMs,
      formatAcceptedAt,
    ),
  };
};
