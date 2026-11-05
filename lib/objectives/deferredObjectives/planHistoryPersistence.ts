import type { Logger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import type { PlanHistoryStore } from './planHistoryStore';
import { normalizeDeferredObjectivePlanHistory } from './planHistorySettings';
import type { PlanHistoryPersistDeps } from './planHistory';

/** Retains the load-failure latch and prevents replacing unread history with an empty snapshot. */
export function createPlanHistoryPersistence(
  store: PlanHistoryStore,
  logger: Logger,
): Pick<PlanHistoryPersistDeps, 'load' | 'save'> {
  let loadUnavailable = false;
  return {
    // The store either answers or throws (I/O). A throw keeps the recorder's
    // persistence closed until a later load succeeds, so an empty in-memory
    // history can never be written over one the process failed to read.
    load: () => {
      let snapshot: ReturnType<typeof normalizeDeferredObjectivePlanHistory>;
      let meteredDeliveryStates: ReturnType<typeof store.readMeteredDelivery>;
      try {
        snapshot = store.read() ?? normalizeDeferredObjectivePlanHistory(null);
        meteredDeliveryStates = store.readMeteredDelivery();
      } catch (error) {
        if (!loadUnavailable) {
          loadUnavailable = true;
          logger.warn({
            event: 'deferred_objective_plan_history_load_unavailable', err: normalizeError(error),
          });
        }
        return {
          snapshot: normalizeDeferredObjectivePlanHistory(null),
          persistenceSafe: false,
          meteredDeliveryStates: [],
        };
      }
      if (loadUnavailable) {
        loadUnavailable = false;
        logger.info({
          event: 'deferred_objective_plan_history_load_recovered',
        });
      }
      return { snapshot, persistenceSafe: true, meteredDeliveryStates };
    },
    save: (next, meteredDeliveryStates) => {
      try {
        store.write(next);
        store.writeMeteredDelivery(meteredDeliveryStates);
        return true;
      } catch (error) {
        logger.error({
          event: 'deferred_objective_plan_history_persist_failed',
          err: normalizeError(error),
        });
        return false;
      }
    },
  };
}
