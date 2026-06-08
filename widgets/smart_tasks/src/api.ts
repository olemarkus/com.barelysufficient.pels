import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../../../packages/contracts/src/settingsUiApi';
import type { SmartTaskHistoryHostApi } from '../../../packages/contracts/src/widgetHostApi';
import { buildSmartTasksWidgetPayload, ENDED_WINDOW_MS } from './smartTasksWidgetPayload';
import type { SmartTasksWidgetPayload } from './smartTasksWidgetTypes';


const readRecentHistory = (
  app: SmartTaskHistoryHostApi | undefined,
  nowMs: number,
): SettingsUiDeferredObjectivePlanHistoryPayload | null => {
  if (typeof app?.getDeferredObjectivePlanHistoryRecentUiPayload === 'function') {
    return app.getDeferredObjectivePlanHistoryRecentUiPayload(nowMs - ENDED_WINDOW_MS);
  }
  if (typeof app?.getDeferredObjectivePlanHistoryUiPayload === 'function') {
    return app.getDeferredObjectivePlanHistoryUiPayload();
  }
  return null;
};

type WidgetApiContext = {
  homey: {
    app?: SmartTaskHistoryHostApi;
    // Homey SDK clock. The widget API runs in the app process (often UTC),
    // so the user's configured timezone must be plumbed explicitly or the
    // detail-panel day/time labels fall back to the host zone.
    clock?: { getTimezone?: () => string };
  };
};

const readTimeZone = (homey: WidgetApiContext['homey']): string | null => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : null;
};

export const getSmartTasks = async ({ homey }: WidgetApiContext): Promise<SmartTasksWidgetPayload> => {
  const app = homey.app;
  const nowMs = Date.now();
  const activePlans = typeof app?.getDeferredObjectiveActivePlansUiPayload === 'function'
    ? app.getDeferredObjectiveActivePlansUiPayload()
    : null;
  const history = readRecentHistory(app, nowMs);
  const devices = typeof app?.getUiPickerDevices === 'function'
    ? app.getUiPickerDevices()
    : [];
  return buildSmartTasksWidgetPayload({
    activePlans,
    history,
    devices,
    nowMs,
    timeZone: readTimeZone(homey),
  });
};
