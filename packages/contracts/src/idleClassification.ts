export type IdleClassification = 'near_target_idle' | 'unresponsive' | 'capped_idle';

/** A classified idle state and the device setpoint that classification used. */
export type StallEvidence = {
  classification: IdleClassification;
  classifiedAgainstTargetValue: number;
  /** Classified setpoint minus current temperature; negative means still warmer. */
  temperatureGapC: number;
};
