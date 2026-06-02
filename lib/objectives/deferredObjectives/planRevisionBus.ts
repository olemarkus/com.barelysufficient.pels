import type {
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

type DeferredObjectivePlanRevisionEventBase = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  previousPlanStatus: DeferredObjectiveActivePlanStatusV1 | null;
  previousWasPending: boolean;
  allocationChanged: boolean;
  projectedFinishAtMs: number | null;
};

export type DeferredObjectivePlanRevisionWrittenEvent = DeferredObjectivePlanRevisionEventBase & {
  eventType: 'revision_written';
  revision: DeferredObjectiveActivePlanRevisionV1;
  reason: DeferredObjectiveActivePlanRevisionReason;
  allocationChanged: boolean;
  // Estimated wall-clock time the device will finish charging under the new
  // plan, derived from the last bucket's fill ratio (plannedKWh / capacityKWh).
  // Null when no bucket is planned or capacity is unknown.
  projectedFinishAtMs: number | null;
};

export type DeferredObjectivePlanPendingEvent = DeferredObjectivePlanRevisionEventBase & {
  eventType: 'pending_written';
  revision: null;
  reason: 'pending';
  allocationChanged: false;
  projectedFinishAtMs: null;
};

export type DeferredObjectivePlanRevisionEvent =
  | DeferredObjectivePlanRevisionWrittenEvent
  | DeferredObjectivePlanPendingEvent;

type Listener = (event: DeferredObjectivePlanRevisionEvent) => void;

export type DeferredObjectivePlanRevisionBus = {
  publish: (event: DeferredObjectivePlanRevisionEvent) => void;
  onRevision: (listener: Listener) => () => void;
};

export const createDeferredObjectivePlanRevisionBus = (): DeferredObjectivePlanRevisionBus => {
  const listeners = new Set<Listener>();
  return {
    publish: (event) => {
      for (const listener of listeners) listener(event);
    },
    onRevision: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
