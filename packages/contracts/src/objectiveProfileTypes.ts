export type ObjectiveProfileKind = 'temperature' | 'ev_soc';

export type ObjectiveProfileConfidence = 'low' | 'medium' | 'high';

export type ObjectiveProfileStat = {
  sampleCount: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
  confidence: ObjectiveProfileConfidence;
  lastUpdatedMs: number;
};

export type DeviceObjectiveProfile = {
  kind: ObjectiveProfileKind;
  updatedAtMs: number;
  lastSample: DeviceObjectiveProfileSample;
  kwhPerUnit?: ObjectiveProfileStat;
  unitPerHour?: ObjectiveProfileStat;
  acceptedSamples: number;
  rejectedSamples: number;
  // Refill-cycle exclusion: when a temperature sensor records a sharp drop
  // (e.g., hot-water draw introducing cold water at the bottom of the tank),
  // the subsequent rebuild from that displaced thermal state is not
  // representative of normal heating. While `recoveryTargetValue` is set,
  // accepted-sample updates are suspended; it clears once the value climbs
  // back to that pre-drop level or the 24h safety timeout elapses.
  recoveryTargetValue?: number;
  recoveryArmedAtMs?: number;
};

export type DeviceObjectiveProfileSample = {
  observedAtMs: number;
  value: number;
  unit: 'degree_c' | 'percent';
  crediblePowerW?: number;
  powerSource?: 'measured' | 'reported_step_planning';
};
