import {
  getSteppedLoadHighestStep,
  isSteppedLoadOffStep,
  sortSteppedLoadSteps,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile, SteppedLoadStep } from '../utils/types';
import type {
  DeferredObjectiveEvaluation,
  DeferredObjectiveProgressStatus,
  DeferredObjectiveRateConfidence,
  DeferredObjectiveRateEstimate,
  DeferredObjectiveReasonCode,
  DeferredObjectiveStatus,
} from './deferredObjectiveTypes';

export type {
  DeferredObjectiveEvaluation,
  DeferredObjectiveProgressStatus,
  DeferredObjectiveRateConfidence,
  DeferredObjectiveRateEstimate,
  DeferredObjectiveReasonCode,
  DeferredObjectiveStatus,
} from './deferredObjectiveTypes';

export type ThermalStorageObjectiveInput = {
  nowMs: number;
  profile?: SteppedLoadProfile;
  measuredTemperatureC?: number;
  measuredTemperatureObservedAtMs?: number;
  maxTemperatureAgeMs?: number;
  targetTemperatureC?: number;
  reserveTemperatureC?: number;
  deadlineAtMs?: number;
  derateFactor?: number;
  rateConfidence?: DeferredObjectiveRateConfidence;
};

const WATER_KWH_PER_LITER_C = 4.186 / 3600;
const DEFAULT_DERATE_FACTOR = 0.75;
const DEFAULT_MAX_TEMPERATURE_AGE_MS = 30 * 60 * 1000;
const BASE_DEADLINE_MARGIN_MS = 15 * 60 * 1000;
const MEDIUM_CONFIDENCE_PENALTY_MS = 15 * 60 * 1000;
const LOW_CONFIDENCE_PENALTY_MS = 45 * 60 * 1000;

export function thermalEnergyDeltaKwh(params: {
  tankVolumeL: number;
  fromTemperatureC: number;
  toTemperatureC: number;
}): number {
  const { tankVolumeL, fromTemperatureC, toTemperatureC } = params;
  if (!isFinitePositive(tankVolumeL)) return 0;
  if (!Number.isFinite(fromTemperatureC) || !Number.isFinite(toTemperatureC)) return 0;
  return Math.max(0, (toTemperatureC - fromTemperatureC) * tankVolumeL * WATER_KWH_PER_LITER_C);
}

export function evaluateThermalStorageObjective(
  input: ThermalStorageObjectiveInput,
): DeferredObjectiveEvaluation {
  const base = buildBaseEvaluation(input);
  const progressStatus = resolveTemperatureProgressStatus(input);
  const factsResult = resolveThermalObjectiveFacts(input, progressStatus);
  if ('reasonCode' in factsResult) return unknownEvaluation(base, factsResult.reasonCode, progressStatus);

  const facts = factsResult;
  const common = buildCommonThermalEvaluation(base, input, facts, progressStatus);
  if (facts.targetTemperatureC > facts.maxStorageTempC) return buildCannotReachTarget(common);
  const energy = buildThermalEnergyFacts(facts);

  if (energy.energyNeededKwh <= 0) return buildTargetMetEvaluation(common, input, energy);
  if (!isFiniteNumber(facts.deadlineAtMs)) return buildMissingDeadlineEvaluation(common, energy);
  if (facts.deadlineAtMs <= input.nowMs) return buildDeadlineMissedEvaluation(common, input, energy);

  const deadlineMarginMs = resolveDeadlineMarginMs(input.rateConfidence ?? 'low');
  const stepEvaluation = evaluateSteppedThermalRates({
    profile: facts.profile,
    energyNeededKwh: energy.energyNeededKwh,
    nowMs: input.nowMs,
    deadlineAtMs: facts.deadlineAtMs,
    deadlineMarginMs,
    derateFactor: input.derateFactor,
    rateConfidence: input.rateConfidence,
  });
  if (!stepEvaluation) {
    return unknownEvaluation({
      ...common,
      ...energy,
      deadlineMarginMs,
    }, 'objective_missing_charge_rate', progressStatus);
  }

  const availableHours = (facts.deadlineAtMs - input.nowMs) / 3_600_000;
  return {
    ...common,
    ...energy,
    status: stepEvaluation.status,
    activeMode: 'soft',
    reasonCode: stepEvaluation.reasonCode,
    requiredAverageKw: energy.energyNeededKwh / availableHours,
    conservativeNetGainKw: stepEvaluation.rateEstimate.deratedKw,
    projectedCompletionAtMs: stepEvaluation.projectedCompletionAtMs,
    deadlineMarginMs,
    rateEstimate: stepEvaluation.rateEstimate,
    requestedMinimumStepId: stepEvaluation.requestedStep.id,
    requestedStepReasonCode: stepEvaluation.reasonCode,
  };
}

export function buildDeferredObjectiveDebugPayload(params: {
  deviceId: string;
  deviceName?: string;
  evaluation: DeferredObjectiveEvaluation;
}): Record<string, unknown> {
  const { deviceId, deviceName, evaluation } = params;
  return {
    event: evaluation.status === 'unknown' ? 'deferred_objective_unknown' : 'deferred_objective_evaluated',
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    objectiveKind: evaluation.kind,
    activeMode: evaluation.activeMode,
    status: evaluation.status,
    reasonCode: evaluation.reasonCode,
    targetTemperatureC: evaluation.targetTemperatureC,
    currentEnergyKwh: evaluation.currentEnergyKwh,
    targetEnergyKwh: evaluation.targetEnergyKwh,
    energyNeededKwh: evaluation.energyNeededKwh,
    deadlineAtMs: evaluation.deadlineAtMs,
    requiredAverageKw: evaluation.requiredAverageKw,
    conservativeNetGainKw: evaluation.conservativeNetGainKw,
    rateConfidence: evaluation.rateEstimate?.confidence,
    deadlineMarginMs: evaluation.deadlineMarginMs,
    projectedCompletionAtMs: evaluation.projectedCompletionAtMs,
    requestedMinimumStepId: evaluation.requestedMinimumStepId,
  };
}

function buildBaseEvaluation(input: ThermalStorageObjectiveInput): DeferredObjectiveEvaluation {
  return {
    kind: 'thermal_storage',
    status: 'unknown',
    activeMode: 'none',
    progressStatus: 'unknown',
    reasonCode: 'objective_unknown',
    targetTemperatureC: input.targetTemperatureC,
    measuredTemperatureC: input.measuredTemperatureC,
    reserveTemperatureC: input.reserveTemperatureC,
    deadlineAtMs: input.deadlineAtMs,
  };
}

type ValidThermalObjectiveFacts = {
  profile: SteppedLoadProfile;
  tankVolumeL: number;
  minComfortTempC: number;
  maxStorageTempC: number;
  measuredTemperatureC: number;
  targetTemperatureC: number;
  reserveTemperatureC?: number;
  deadlineAtMs?: number;
};

type ThermalEnergyFacts = {
  currentEnergyKwh: number;
  targetEnergyKwh: number;
  usableCapacityKwh: number;
  energyNeededKwh: number;
};

function resolveThermalObjectiveFacts(
  input: ThermalStorageObjectiveInput,
  progressStatus: DeferredObjectiveProgressStatus,
): ValidThermalObjectiveFacts | { reasonCode: DeferredObjectiveReasonCode } {
  if (progressStatus === 'stale') return { reasonCode: 'objective_progress_stale' };
  if (progressStatus === 'unknown') return { reasonCode: 'objective_missing_temperature' };
  const profileFacts = resolveThermalProfileFacts(input.profile);
  if (!profileFacts) return { reasonCode: 'objective_missing_thermal_profile' };
  if (!isFiniteNumber(input.measuredTemperatureC)) return { reasonCode: 'objective_missing_temperature' };
  if (!isFiniteNumber(input.targetTemperatureC)) return { reasonCode: 'objective_missing_target' };
  return {
    ...profileFacts,
    measuredTemperatureC: input.measuredTemperatureC,
    targetTemperatureC: input.targetTemperatureC,
    reserveTemperatureC: input.reserveTemperatureC,
    deadlineAtMs: input.deadlineAtMs,
  };
}

function resolveThermalProfileFacts(profile: SteppedLoadProfile | undefined): Pick<
  ValidThermalObjectiveFacts,
  'profile' | 'tankVolumeL' | 'minComfortTempC' | 'maxStorageTempC'
> | null {
  const tankVolumeL = profile?.tankVolumeL;
  const minComfortTempC = profile?.minComfortTempC;
  const maxStorageTempC = profile?.maxStorageTempC;
  if (!profile || !isFinitePositive(tankVolumeL)) return null;
  if (!isFiniteNumber(minComfortTempC) || !isFiniteNumber(maxStorageTempC)) return null;
  return { profile, tankVolumeL, minComfortTempC, maxStorageTempC };
}

function buildCommonThermalEvaluation(
  base: DeferredObjectiveEvaluation,
  input: ThermalStorageObjectiveInput,
  facts: ValidThermalObjectiveFacts,
  progressStatus: DeferredObjectiveProgressStatus,
): DeferredObjectiveEvaluation {
  return {
    ...base,
    progressStatus,
    targetTemperatureC: facts.targetTemperatureC,
    measuredTemperatureC: facts.measuredTemperatureC,
    reserveTemperatureC: input.reserveTemperatureC,
    deadlineAtMs: facts.deadlineAtMs,
  };
}

function buildThermalEnergyFacts(facts: ValidThermalObjectiveFacts): ThermalEnergyFacts {
  const baselineTemperatureC = facts.reserveTemperatureC ?? facts.minComfortTempC;
  const currentEnergyKwh = thermalEnergyDeltaKwh({
    tankVolumeL: facts.tankVolumeL,
    fromTemperatureC: baselineTemperatureC,
    toTemperatureC: facts.measuredTemperatureC,
  });
  const targetEnergyKwh = thermalEnergyDeltaKwh({
    tankVolumeL: facts.tankVolumeL,
    fromTemperatureC: baselineTemperatureC,
    toTemperatureC: facts.targetTemperatureC,
  });
  const usableCapacityKwh = thermalEnergyDeltaKwh({
    tankVolumeL: facts.tankVolumeL,
    fromTemperatureC: baselineTemperatureC,
    toTemperatureC: facts.maxStorageTempC,
  });
  return {
    currentEnergyKwh,
    targetEnergyKwh,
    usableCapacityKwh,
    energyNeededKwh: Math.max(0, targetEnergyKwh - currentEnergyKwh),
  };
}

function buildCannotReachTarget(
  common: DeferredObjectiveEvaluation,
): DeferredObjectiveEvaluation {
  return {
    ...common,
    status: 'cannot_be_met',
    activeMode: 'soft',
    reasonCode: 'objective_mode_cannot_reach_target',
  };
}

function buildTargetMetEvaluation(
  common: DeferredObjectiveEvaluation,
  input: ThermalStorageObjectiveInput,
  energy: ThermalEnergyFacts,
): DeferredObjectiveEvaluation {
  return {
    ...common,
    ...energy,
    status: 'likely_to_meet',
    activeMode: 'none',
    reasonCode: 'objective_target_met',
    deadlineMarginMs: resolveDeadlineMarginMs(input.rateConfidence ?? 'low'),
  };
}

function buildMissingDeadlineEvaluation(
  common: DeferredObjectiveEvaluation,
  energy: ThermalEnergyFacts,
): DeferredObjectiveEvaluation {
  return {
    ...common,
    ...energy,
    status: 'unknown',
    activeMode: 'none',
    reasonCode: 'objective_missing_deadline',
  };
}

function buildDeadlineMissedEvaluation(
  common: DeferredObjectiveEvaluation,
  input: ThermalStorageObjectiveInput,
  energy: ThermalEnergyFacts,
): DeferredObjectiveEvaluation {
  return {
    ...common,
    ...energy,
    status: 'cannot_be_met',
    activeMode: 'soft',
    reasonCode: 'objective_deadline_missed',
    deadlineMarginMs: resolveDeadlineMarginMs(input.rateConfidence ?? 'low'),
  };
}

function unknownEvaluation(
  base: DeferredObjectiveEvaluation,
  reasonCode: DeferredObjectiveReasonCode,
  progressStatus: DeferredObjectiveProgressStatus,
): DeferredObjectiveEvaluation {
  return {
    ...base,
    status: 'unknown',
    activeMode: 'none',
    progressStatus,
    reasonCode,
  };
}

function resolveTemperatureProgressStatus(input: ThermalStorageObjectiveInput): DeferredObjectiveProgressStatus {
  if (!Number.isFinite(input.measuredTemperatureC)) return 'unknown';
  const observedAtMs = input.measuredTemperatureObservedAtMs;
  if (!isFiniteNumber(observedAtMs)) return 'unknown';
  const maxAgeMs = input.maxTemperatureAgeMs ?? DEFAULT_MAX_TEMPERATURE_AGE_MS;
  return input.nowMs - observedAtMs > maxAgeMs ? 'stale' : 'fresh';
}

function resolveDeadlineMarginMs(confidence: DeferredObjectiveRateConfidence): number {
  if (confidence === 'high') return BASE_DEADLINE_MARGIN_MS;
  if (confidence === 'medium') return BASE_DEADLINE_MARGIN_MS + MEDIUM_CONFIDENCE_PENALTY_MS;
  return BASE_DEADLINE_MARGIN_MS + LOW_CONFIDENCE_PENALTY_MS;
}

function evaluateSteppedThermalRates(params: {
  profile: SteppedLoadProfile;
  energyNeededKwh: number;
  nowMs: number;
  deadlineAtMs: number;
  deadlineMarginMs: number;
  derateFactor?: number;
  rateConfidence?: DeferredObjectiveRateConfidence;
}): {
  status: Exclude<DeferredObjectiveStatus, 'unknown'>;
  reasonCode: DeferredObjectiveReasonCode;
  requestedStep: SteppedLoadStep;
  projectedCompletionAtMs: number;
  rateEstimate: DeferredObjectiveRateEstimate;
} | null {
  const positiveSteps = sortSteppedLoadSteps(params.profile.steps)
    .filter((step) => !isSteppedLoadOffStep(params.profile, step.id) && step.planningPowerW > 0);
  if (positiveSteps.length === 0) return null;

  const stepResults = positiveSteps.map((step) => {
    const rateEstimate = buildRateEstimate({
      step,
      derateFactor: params.derateFactor,
      confidence: params.rateConfidence,
    });
    if (!rateEstimate) return null;
    return {
      step,
      rateEstimate,
      projectedCompletionAtMs: params.nowMs + (params.energyNeededKwh / rateEstimate.deratedKw) * 3_600_000,
    };
  }).filter((result): result is {
    step: SteppedLoadStep;
    rateEstimate: DeferredObjectiveRateEstimate;
    projectedCompletionAtMs: number;
  } => result !== null);
  if (stepResults.length === 0) return null;
  const marginStep = stepResults.find((result) => (
    result.projectedCompletionAtMs <= params.deadlineAtMs - params.deadlineMarginMs
  ));
  if (marginStep) {
    return {
      status: 'likely_to_meet',
      reasonCode: 'objective_likely_to_meet',
      requestedStep: marginStep.step,
      projectedCompletionAtMs: marginStep.projectedCompletionAtMs,
      rateEstimate: marginStep.rateEstimate,
    };
  }

  const deadlineStep = stepResults.find((result) => result.projectedCompletionAtMs <= params.deadlineAtMs);
  if (deadlineStep) {
    return {
      status: 'at_risk',
      reasonCode: 'objective_at_risk',
      requestedStep: deadlineStep.step,
      projectedCompletionAtMs: deadlineStep.projectedCompletionAtMs,
      rateEstimate: deadlineStep.rateEstimate,
    };
  }

  const highestStep = getSteppedLoadHighestStep(params.profile);
  const highestResult = stepResults.find((result) => result.step.id === highestStep?.id) ?? stepResults.at(-1);
  if (!highestResult) return null;
  return {
    status: 'cannot_be_met',
    reasonCode: 'objective_cannot_be_met',
    requestedStep: highestResult.step,
    projectedCompletionAtMs: highestResult.projectedCompletionAtMs,
    rateEstimate: highestResult.rateEstimate,
  };
}

function buildRateEstimate(params: {
  step: SteppedLoadStep;
  derateFactor?: number;
  confidence?: DeferredObjectiveRateConfidence;
}): DeferredObjectiveRateEstimate | null {
  const nominalKw = params.step.planningPowerW / 1000;
  const derateFactor = isFiniteNumber(params.derateFactor)
    ? Math.max(0, Math.min(1, params.derateFactor))
    : DEFAULT_DERATE_FACTOR;
  const deratedKw = nominalKw * derateFactor;
  if (!isFinitePositive(deratedKw)) return null;
  return {
    nominalKw,
    deratedKw,
    kind: 'configured_planning_power',
    confidence: params.confidence ?? 'low',
    sourceKey: params.step.id,
  };
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
