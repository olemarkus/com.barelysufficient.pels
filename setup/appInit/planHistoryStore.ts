import type { AppContext } from '../../lib/app/appContext';
import {
  createPlanHistoryStore,
  importLegacyPlanHistory,
  type PlanHistoryStore,
} from '../../lib/objectives/deferredObjectives/planHistoryStore';

/**
 * The smart-task plan history's repository on the app's userdata database,
 * with the one-shot import of the legacy settings blobs run before anything
 * reads it. Built where the recorder is wired, not in one file that opens
 * the database and lists every domain's repository: a domain's wiring owns
 * its repository, and a wiring file naming every domain would be the
 * cross-peer composition the layer's rules forbid.
 */
export const createPlanHistoryStoreForApp = (ctx: AppContext): PlanHistoryStore => {
  const store = createPlanHistoryStore(ctx.getUserdataDatabase());
  importLegacyPlanHistory(ctx.homey.settings, store);
  return store;
};
