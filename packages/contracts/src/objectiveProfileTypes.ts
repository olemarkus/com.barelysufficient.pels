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
};

export type DeviceObjectiveProfileSample = {
  observedAtMs: number;
  value: number;
  unit: 'degree_c' | 'percent';
  crediblePowerW?: number;
  powerSource?: 'measured' | 'reported_step_planning';
};
