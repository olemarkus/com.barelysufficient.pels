export type DeferredObjectivePlanOutcome =
  | 'met'
  | 'missed'
  | 'abandoned'
  | 'unknown';

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
};

export type DeferredObjectivePlanHistoryV1 = {
  version: 1;
  entries: DeferredObjectivePlanHistoryEntry[];
};
