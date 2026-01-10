import type Homey from 'homey';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import type { HomeyDeviceLike } from './lib/utils/types';

type ApiContext = {
  homey: Homey.App['homey'];
};

type DailyBudgetApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
  getHomeyDevicesForDebug?: () => Promise<HomeyDeviceLike[]>;
  logHomeyDeviceForDebug?: (deviceId: string) => Promise<boolean>;
};

const hasDeviceId = (device: HomeyDeviceLike): device is HomeyDeviceLike & { id: string } => (
  typeof device.id === 'string'
);

const getApp = (homey: Homey.App['homey']): DailyBudgetApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as DailyBudgetApp;
};

export = {
  async get_daily_budget({ homey }: ApiContext): Promise<DailyBudgetUiPayload | null> {
    const app = getApp(homey);
    if (!app?.getDailyBudgetUiPayload) return null;
    try {
      return app.getDailyBudgetUiPayload();
    } catch (error) {
      app?.error?.('Daily budget API failed', error as Error);
      return null;
    }
  },
  async homey_devices({ homey }: ApiContext): Promise<Array<{ id: string; name?: string; class?: string }>> {
    const app = getApp(homey);
    if (!app?.getHomeyDevicesForDebug) return [];
    try {
      const devices = await app.getHomeyDevicesForDebug();
      return devices
        .filter(hasDeviceId)
        .map((device) => {
          const deviceClass = typeof device.class === 'string' ? device.class : undefined;
          return {
            id: device.id,
            name: device.name,
            class: deviceClass,
          };
        });
    } catch (error) {
      app?.error?.('Homey devices API failed', error as Error);
      return [];
    }
  },
  async log_homey_device(
    { homey, body }: ApiContext & { body?: { id?: string } },
  ): Promise<{ ok: boolean; error?: string }> {
    const app = getApp(homey);
    if (!app?.logHomeyDeviceForDebug) {
      return { ok: false, error: 'LOGGING_NOT_AVAILABLE' };
    }
    try {
      const deviceId = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!deviceId) {
        app?.error?.('Homey device log API called without valid device id');
        return { ok: false, error: 'INVALID_DEVICE_ID' };
      }
      const ok = await app.logHomeyDeviceForDebug(deviceId);
      if (!ok) {
        return { ok: false, error: 'DEVICE_NOT_FOUND' };
      }
      return { ok: true };
    } catch (error) {
      app?.error?.('Homey device log API failed', error as Error);
      return { ok: false, error: 'INTERNAL_ERROR' };
    }
  },
};
