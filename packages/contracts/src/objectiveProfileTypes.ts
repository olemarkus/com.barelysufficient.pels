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
  // Count of consecutive armed-window samples that showed no positive movement
  // toward `recoveryTargetValue`. Disarms the window once this hits
  // `RECOVERY_NO_PROGRESS_SAMPLE_LIMIT` so a capacity-shed thermostat cooling
  // *away* from the pre-drop value doesn't sit rejected for the full 24h
  // safety timeout. Resets to 0 whenever a sample shows forward progress.
  // Optional for backward compatibility — legacy profiles missing the field
  // are treated as 0.
  recoveryNoProgressSamples?: number;
  // Recent (input, kWh/unit) samples kept verbatim so the band fitter can
  // re-bucket data when the value distribution shifts. Bounded ring buffer
  // (newest at the end); legacy profiles without this field still load.
  samples?: ObjectiveProfileSampleObservation[];
  // Contiguous, sorted bands of kWh/unit covering the observed input range.
  // Absent when the buffer holds too few samples to split usefully; the
  // estimator then falls back to the global `kwhPerUnit` mean.
  bands?: ObjectiveProfileBand[];
  // In-progress energy accumulator for the open baseline→rise window. Stepped
  // devices change power mid-window (e.g. 1193 → 1671 → 2865 W); billing the
  // whole window at the baseline sample's single power poisons `kwhPerUnit`.
  // Instead we sum each sub-interval at its own left-edge power
  // (`Σ crediblePowerW_i × Δt_i`) across the `rise_too_small` skips that the
  // baseline-preserving path used to discard. The accumulator spans multiple
  // planning cycles, so it is persisted: a restart or settings reload mid-window
  // must not drop the partial sum (which would under-count the energy when the
  // value finally moves). All three optional for backward compatibility — a
  // legacy profile loads with them absent and the open sub-interval seeds from
  // `lastSample` (identical to the pre-accumulator behaviour for a window with
  // no skips).
  //
  // `pendingEnergyKWh` — kWh summed over sub-intervals already closed since the
  //   current baseline (`lastSample`).
  // `subIntervalStartMs` — `observedAtMs` of the most recent raw sample = the
  //   open sub-interval's left edge. Absent → seed from `lastSample`.
  // `subIntervalPowerW` — `crediblePowerW` of that same raw sample = the power
  //   to bill the next sub-interval. Absent → seed from `lastSample`. A
  //   sub-interval whose left-edge power is absent or 0 is thermally
  //   contaminated (coasting, not electrical heat): the window is discarded and
  //   the baseline reset rather than averaged.
  pendingEnergyKWh?: number;
  subIntervalStartMs?: number;
  subIntervalPowerW?: number;
};

export type ObjectiveProfileSampleObservation = {
  observedAtMs: number;
  inputValue: number;
  kwhPerUnit: number;
};

export type ObjectiveProfileBand = {
  lowerInclusive: number;
  upperExclusive: number;
  sampleCount: number;
  mean: number;
  m2: number;
  confidence: ObjectiveProfileConfidence;
};

export type DeviceObjectiveProfileSample = {
  observedAtMs: number;
  value: number;
  unit: 'degree_c' | 'percent';
  crediblePowerW?: number;
  powerSource?: 'measured' | 'reported_step_planning';
};
