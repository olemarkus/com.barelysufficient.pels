import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import { readPelsHost } from '../../../lib/app/pelsHost';
import { buildDeviceWidgetPayload } from './deviceWidgetPayload';
import type { DeviceWidgetPayload } from './deviceWidgetTypes';

// The creation flow's routes are the New smart task widget's own handlers: the
// same request, the same validation, the same app methods.
export {
  createCreateSmartTask,
  getCreateSmartTaskQuickTargets,
  previewCreateSmartTask,
} from '../../create_smart_task/src/api';

type WidgetApiContext = {
  homey: {
    app?: unknown;
    // The widget API runs in the app process (often UTC), so the user's
    // timezone is plumbed explicitly for the tile's local times.
    clock?: { getTimezone?: () => string };
  };
  body?: unknown;
};

const readTimeZone = (homey: WidgetApiContext['homey']): string | null => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : null;
};

const readDeviceId = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { deviceId } = body as { deviceId?: unknown };
  return typeof deviceId === 'string' && deviceId.trim().length > 0 ? deviceId.trim() : null;
};

// The tile's read for the device in the body (`{ deviceId }`, from the widget's
// Device setting). An unknown or missing device reads as not managed.
export const getDeviceWidget = async ({ homey, body }: WidgetApiContext): Promise<DeviceWidgetPayload> => {
  const host = readPelsHost(homey);
  if (!host) return { state: 'starting' };
  const deviceId = readDeviceId(body);
  if (deviceId === null) return { state: 'not_managed' };
  return buildDeviceWidgetPayload(host, deviceId, Date.now(), readTimeZone(homey));
};

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('device', context)
);
