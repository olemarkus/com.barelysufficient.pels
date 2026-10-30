import { readPelsHost } from '../../lib/app/pelsHost';
import { normalizeError } from '../../lib/utils/errorUtils';
import { API_STARTING_MESSAGE, defineRoutes, type ApiContext } from './defineRoutes';

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
  ui_charging_access_remove: ({ homey }: ApiContext) => chargingAccess(homey).remove(),
});
