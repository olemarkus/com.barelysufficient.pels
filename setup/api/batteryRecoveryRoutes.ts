import { readPelsHost } from '../../lib/app/pelsHost';
import { API_STARTING_MESSAGE, defineRoutes, type ApiContext } from './defineRoutes';

export const batteryRecoveryRoutes = defineRoutes({
  ui_battery_recovery: ({ homey, params, body }: ApiContext & { params: { deviceId: string }; body?: unknown }) => {
    const battery = readPelsHost(homey)?.batteryControl;
    if (!battery) throw new Error(API_STARTING_MESSAGE);
    return battery.resolveLegacyRecovery(params.deviceId, body);
  },
});
