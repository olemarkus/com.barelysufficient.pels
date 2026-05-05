export type DeferredObjectiveKind = 'thermal_storage';
export type DeferredObjectiveStatus = 'unknown' | 'likely_to_meet' | 'at_risk' | 'cannot_be_met';
export type DeferredObjectiveActiveMode = 'none' | 'soft';
export type DeferredObjectiveProgressStatus = 'unknown' | 'fresh' | 'stale';
export type DeferredObjectiveRateConfidence = 'high' | 'medium' | 'low';
export type DeferredObjectiveReasonCode =
  | 'objective_unknown'
  | 'objective_progress_stale'
  | 'objective_missing_deadline'
  | 'objective_missing_target'
  | 'objective_missing_temperature'
  | 'objective_missing_thermal_profile'
  | 'objective_missing_charge_rate'
  | 'objective_mode_cannot_reach_target'
  | 'objective_likely_to_meet'
  | 'objective_at_risk'
  | 'objective_cannot_be_met'
  | 'objective_target_met'
  | 'objective_deadline_missed';

export type DeferredObjectiveRateEstimate = {
  nominalKw: number;
  deratedKw: number;
  kind: 'configured_planning_power';
  confidence: DeferredObjectiveRateConfidence;
  sourceKey?: string;
};

export type DeferredObjectiveEvaluation = {
  kind: DeferredObjectiveKind;
  status: DeferredObjectiveStatus;
  activeMode: DeferredObjectiveActiveMode;
  progressStatus: DeferredObjectiveProgressStatus;
  reasonCode: DeferredObjectiveReasonCode;
  targetTemperatureC?: number;
  measuredTemperatureC?: number;
  reserveTemperatureC?: number;
  currentEnergyKwh?: number;
  targetEnergyKwh?: number;
  usableCapacityKwh?: number;
  energyNeededKwh?: number;
  requiredAverageKw?: number;
  conservativeNetGainKw?: number;
  projectedCompletionAtMs?: number;
  deadlineAtMs?: number;
  deadlineMarginMs?: number;
  rateEstimate?: DeferredObjectiveRateEstimate;
  requestedMinimumStepId?: string;
  requestedStepReasonCode?: DeferredObjectiveReasonCode;
};
