export type DeferredObjectivePlanOutcome =
  | 'met'
  | 'missed'
  | 'abandoned'
  | 'unknown';

export type DeferredObjectivePlanHistoryDiscoveredFrom = 'observation' | 'backfill';

export type DeferredObjectivePlanHistoryObservedInterval = {
  fromMs: number;
  toMs: number;
};

export type DeferredObjectivePlanHistoryEntry = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  startedAtMs: number;
  finalizedAtMs: number;
  startProgressC: number | null;
  startProgressPercent: number | null;
  finalProgressC: number | null;
  finalProgressPercent: number | null;
  initialEnergyNeededKWh: number;
  outcome: DeferredObjectivePlanOutcome;
  metAtMs: number | null;
  usedDeadlineReserve: boolean;
  usedPolicyAvoid: boolean;
  observedIntervals: DeferredObjectivePlanHistoryObservedInterval[];
  discoveredFrom: DeferredObjectivePlanHistoryDiscoveredFrom;
};

export type DeferredObjectivePlanHistoryV2 = {
  version: 2;
  entries: DeferredObjectivePlanHistoryEntry[];
};

// Legacy v1 entry shape kept only so the migration in planHistorySettings.ts can read pre-v2
// data. The v1 envelope (`{ version: 1, entries: ... }`) isn't exported as a type because no
// production code constructs it — migration accepts arbitrary unknown input and validates.
export type DeferredObjectivePlanHistoryEntryV1 = Omit<
  DeferredObjectivePlanHistoryEntry,
  'observedIntervals' | 'discoveredFrom'
>;
