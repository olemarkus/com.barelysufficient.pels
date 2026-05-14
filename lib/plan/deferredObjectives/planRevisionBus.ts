import type {
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

export type DeferredObjectivePlanRevisionEvent = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  revision: DeferredObjectiveActivePlanRevisionV1;
  reason: DeferredObjectiveActivePlanRevisionReason;
  allocationChanged: boolean;
  // Estimated wall-clock time the device will finish charging under the new
  // plan, derived from the last bucket's fill ratio (plannedKWh / capacityKWh).
  // Null when no bucket is planned or capacity is unknown.
  projectedFinishAtMs: number | null;
};

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
