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
  updatedAtMs: number;
  lastSample: DeviceObjectiveProfileSample;
  /**
   * The device's learned energy cost per unit, DERIVED from `samples` each time
   * an observation is recorded — not accumulated independently of it. So its
   * `sampleCount` is the number of observations the buffer currently holds
   * (bounded by size and by age), never a lifetime total; `acceptedSamples`
   * below remains the lifetime counter, and that is the one provenance reports.
   *
   * Derived rather than accumulated because a running Welford pair cannot have
   * a contribution removed: an observation that aged out of the buffer would
   * otherwise stay in this mean for the life of the profile, and
   * `resolveProfileEnergy` sizes every smart task from exactly this mean. A
   * device whose real rate moved would be relearning in the buffer and still
   * planning at the old figure.
   */
  kwhPerUnit?: ObjectiveProfileStat;
  // Still a lifetime running pair — nothing buffers the per-hour rate, and no
  // estimator reads it, so there is no stale-history problem to solve here.
  unitPerHour?: ObjectiveProfileStat;
  acceptedSamples: number;
  rejectedSamples: number;
  // No refill-recovery cluster. There used to be one — a sharp fall armed a
  // window (`recoveryTargetValue` / `recoveryArmedAtMs` /
  // `recoveryNoProgressSamples`) that suspended ALL learning until the value
  // climbed back, 24h elapsed, or four samples showed no progress. It was an
  // indirect proxy: detect the fall, then blanket-suppress whatever followed,
  // including the windows that were perfectly ordinary. Each contaminated
  // window is now refused on its own merit against the device's learned
  // kWh/unit band (`lib/objectives/energyBand.ts`), so a multi-window refill is
  // simply several refusals and nothing legitimate is caught in the blast
  // radius. A blob written by the older build still validates — the three keys
  // are ignored, not rejected (`isPlausiblePowerTrackerState`).
  //
  // Recent (input, kWh/unit) samples kept verbatim so the band fitter can
  // re-bucket data when the value distribution shifts. Bounded ring buffer
  // (newest at the end), bounded by AGE as well as size — see
  // `OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS`. Absent until the first accepted
  // observation. This is the single record of what the device costs per unit:
  // `bands` and `kwhPerUnit` are both derived from it.
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
  // Outdoor temperature when the rise window closed, recorded so a future
  // estimator can condition heating rates on weather. Written only when a
  // reading was available (`profiles.ts` spreads it conditionally), so absence
  // means "no weather for that window" — an ordinary shape, not a legacy one.
  outdoorTemperatureC?: number;
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
  crediblePowerW?: number;
  powerSource?: 'measured' | 'reported_step_planning';
};
