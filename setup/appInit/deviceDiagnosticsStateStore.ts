import type { AppContext } from '../../lib/app/appContext';
import {
  createDeviceDiagnosticsStateStore,
  importLegacyDeviceDiagnostics,
  type DeviceDiagnosticsStateStore,
} from '../../lib/diagnostics/deviceDiagnosticsStateStore';

/**
 * The device diagnostics' repository on the app's userdata database, with
 * the one-shot import of the legacy settings blob run before anything reads
 * it. Built where the service is wired, not in one file that lists every
 * domain's repository: a domain's wiring owns its repository
 * (`setup/appInit/planHistoryStore.ts` is the pattern).
 */
export const createDeviceDiagnosticsStateStoreForApp = (ctx: AppContext): DeviceDiagnosticsStateStore => {
  const store = createDeviceDiagnosticsStateStore(ctx.getUserdataDatabase());
  importLegacyDeviceDiagnostics(ctx.homey.settings, store);
  return store;
};
