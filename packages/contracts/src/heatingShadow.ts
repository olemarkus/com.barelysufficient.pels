/** Passive chronological evidence owned by lib/diagnostics, never planner input. */
export type HeatingShadowSignal = {
  temperatureCapability: 'measure_temperature';
  /** Current transport does not resolve floor/air regulation; do not infer it from names. */
  temperatureRole: 'unclassified';
  targetCapability: string;
  electricalInput: 'held_reported_direct_power';
};

export type HeatingShadowReading = {
  /** Meter-ingest time for accepted held values, not a fresh capability-event timestamp. */
  atMs: number;
  temperatureC: number;
  powerKw: number;
  targetC: number;
  control: 'enabled' | 'disabled' | 'unobserved';
};

/** A complete accepted device observation and its reporting semantics. */
export type HeatingShadowDevice = {
  id: string;
  signal: HeatingShadowSignal;
  reading: HeatingShadowReading;
};

export type HeatingShadowInterval = {
  startMs: number;
  endMs: number;
  startTemperatureC: number;
  endTemperatureC: number;
  meanTemperatureC: number;
  inputKWh: number;
  /** Observed target at the interval start; changes remain in flags and change observations. */
  targetC: number;
  /** Bit 1: target changed; 2: observed off; 4: control unobserved; 8: partial window. */
  flags: number;
  observations: number;
  maximumGapMs: number;
};

export type HeatingShadowWindow = {
  start: HeatingShadowReading;
  last: HeatingShadowReading;
  inputKWh: number;
  temperatureIntegralCHours: number;
  flags: number;
  observations: number;
  maximumGapMs: number;
};

export type HeatingShadowDeviceDay = {
  signal: HeatingShadowSignal;
  intervals: HeatingShadowInterval[];
  /** Initial observation and significant power/target/control transitions, oldest first. */
  changes: HeatingShadowReading[];
  window?: HeatingShadowWindow;
  omittedIntervals: number;
  omittedChanges: number;
  interruptions: number;
  signalChanged: boolean;
};

export type HeatingShadowOutdoorPoint =
  | { atMs: number; state: 'available'; temperatureC: number }
  | { atMs: number; state: 'unavailable' };

export type HeatingShadowDay = {
  dateKey: string;
  startMs: number;
  endMs: number;
  devices: Record<string, HeatingShadowDeviceDay>;
  /** Bounded union of eligible ids; local config home labels are not household identities. */
  eligibleDeviceIds: string[];
  /** Counts derived from eligible ids are lower bounds if this bounded pool overflowed. */
  eligibleIdsTruncated: boolean;
  outdoor: HeatingShadowOutdoorPoint[];
  omittedOutdoorPoints: number;
};

export type HeatingShadowState = {
  version: 1;
  timeZone: string;
  days: HeatingShadowDay[];
};
