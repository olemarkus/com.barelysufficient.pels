import {
  formatSmartTaskExtraPermissionsValue,
  resolveKwhPerUnitProvenanceRows,
  SMART_TASK_GUARANTEE_COPY,
  formatSmartTaskPriorityNote,
} from '../../../shared-domain/src/deadlineLabels.ts';
import type { DeadlinePlanSchedule, ObjectivePayloadReady } from './deadlinePlanData.ts';
import { hasObservedMeasuredPower } from '../../../shared-domain/src/measuredPowerObservedState.ts';
import { formatAcceptedAt } from './deadlinePlanFormatters.ts';
import { resolveDisplayRateAndSpeedMode } from './deadlinePlanResolvers.ts';
import type { DeadlinePlanPayload } from './views/DeadlinePlan.tsx';

const formatPerUnitRateLabel = (
  kwhPerUnitMean: number | null | undefined,
): string | null => {
  if (typeof kwhPerUnitMean !== 'number' || !Number.isFinite(kwhPerUnitMean) || kwhPerUnitMean <= 0) {
    return null;
  }
  return `${kwhPerUnitMean.toFixed(2)} kWh`;
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
  const planningSpeedKw = resolvePositiveNumber(activePlan.latest.planningSpeedKw);
  return {
    perUnitRateLabel: objective.kind === 'energy' ? null : formatPerUnitRateLabel(rateMean),
    perUnitRateNote: usingBootstrap ? labels.planInputsRateBootstrapNote : null,
    maxPowerLabel: planningSpeedKw === null ? null : `At least ${formatMaxPowerLabel(planningSpeedKw)}`,
    maxPowerNote: planningSpeedKw === null ? null : SMART_TASK_GUARANTEE_COPY.conditions,
    measuredPowerLabel: hasObservedMeasuredPower(device) ? formatMaxPowerLabel(device.measuredPowerKw) : null,
    priorityLabel: device.priority === undefined ? null : `Priority ${device.priority}`,
    priorityNote: device.priority === undefined ? null : formatSmartTaskPriorityNote(device.priority),
    extraPermissionsValue: formatSmartTaskExtraPermissionsValue(objective.rescue),
    provenanceRows: resolveKwhPerUnitProvenanceRows(
      activePlan.kwhPerUnitProvenance,
      nowMs,
      formatAcceptedAt,
    ),
  };
};
