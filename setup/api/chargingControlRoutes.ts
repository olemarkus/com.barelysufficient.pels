import { readPelsHost } from '../../lib/app/pelsHost';
import { normalizeError } from '../../lib/utils/errorUtils';
import { API_STARTING_MESSAGE, defineRoutes, type ApiContext } from './defineRoutes';

/** Why the key was kept: a battery PELS drives with it could not be handed back to its app first. */
export const HOMEY_API_KEY_HOLDS_BATTERY_MESSAGE
  = 'PELS could not hand a battery back to its app, so the key was kept. Try again in a minute.';

export const HOMEY_API_KEY_CLAIMS_UNREADABLE_MESSAGE
  = 'PELS could not check whether any batteries still need the key, so it was kept. Try again in a minute.';

function chargingAccess(homey: ApiContext['homey']) {
  const transport = readPelsHost(homey)?.deviceManager;
  if (!transport) throw new Error(API_STARTING_MESSAGE);
  return transport.chargingAccess;
}

export const chargingControlRoutes = defineRoutes({
  ui_charging_current: ({ homey }: ApiContext) => {
    const host = readPelsHost(homey);
    // A read can apply a route change, which rebuilds the plan.
    if (!host?.deviceManager || !host.planService) throw new Error(API_STARTING_MESSAGE);
    return host.readChargingCurrentForUi();
  },
  ui_charging_current_save: async (
    { homey, params, body }: ApiContext & { params: { deviceId: string }; body?: unknown },
  ) => {
    const host = readPelsHost(homey);
    const transport = host?.deviceManager;
    if (!host || !transport) throw new Error(API_STARTING_MESSAGE);
    await transport.chargingCurrentControl.save(params.deviceId, body);
    try {
      await host.refreshTargetDevicesSnapshot();
    } catch (error) {
      // The owner has committed the route and already gates commands and Flow
      // reports. A projection failure must not report that this save failed.
      host.getApiStructuredLogger()?.warn({
        event: 'charging_control_snapshot_refresh_failed', deviceId: params.deviceId, err: normalizeError(error),
      });
    }
  },
  ui_charging_access: ({ homey }: ApiContext) => chargingAccess(homey).status(),
  ui_charging_access_check: ({ homey }: ApiContext) => chargingAccess(homey).check(),
  ui_charging_access_save: ({ homey, body }: ApiContext & { body?: unknown }) => chargingAccess(homey).save(body),
  // A battery PELS drives through its app's actions is handed back while the
  // key it runs on is still there (`handBackBeforeHomeyApiKeyRemoval`).
  ui_charging_access_remove: async ({ homey }: ApiContext) => {
    const access = chargingAccess(homey);
    const batteryControl = readPelsHost(homey)?.batteryControl;
    if (!batteryControl) throw new Error(API_STARTING_MESSAGE);
    const removal = await batteryControl.handBackBeforeHomeyApiKeyRemoval(() => { access.remove(); });
    if (removal === 'claim_records_unreadable') throw new Error(HOMEY_API_KEY_CLAIMS_UNREADABLE_MESSAGE);
    if (removal === 'battery_held') throw new Error(HOMEY_API_KEY_HOLDS_BATTERY_MESSAGE);
    return access.status();
  },
});
