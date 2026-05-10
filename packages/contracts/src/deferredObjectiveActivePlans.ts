// Type-only file: runtime code must not value-import contracts per the
// packaging boundary. The schema version literal lives at the runtime side
// (`lib/plan/deferredObjectives/activePlanSettings.ts`).

export type DeferredObjectiveActivePlanRevisionReason =
  | 'flow_card'
  | 'prices_arrived'
  | 'objective_changed'
  | 'prices_revised'
  | 'device_unavailable'
  | 'measured_deviation';

export type DeferredObjectiveActivePlanHourV1 = {
  startsAtMs: number;
  plannedKWh: number;
};

export type DeferredObjectiveActivePlanRevisionV1 = {
  revision: number;
  revisedAtMs: number;
  computedFromPricesUpTo: number | null;
  reason: DeferredObjectiveActivePlanRevisionReason;
  hours: DeferredObjectiveActivePlanHourV1[];
};

export type DeferredObjectiveActivePlanV1 = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  startedAtMs: number;
  pending: boolean;
  // The signature of the objective settings that produced `latest`. Used to
  // detect `objective_changed` replans without re-deriving the hash on every
  // load.
  objectiveSignature: string;
  original: DeferredObjectiveActivePlanRevisionV1 | null;
  latest: DeferredObjectiveActivePlanRevisionV1 | null;
};

export type DeferredObjectiveActivePlansV1 = {
  version: 1;
  plansByDeviceId: Record<string, DeferredObjectiveActivePlanV1>;
};
