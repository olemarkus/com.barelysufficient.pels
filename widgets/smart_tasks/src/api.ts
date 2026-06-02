import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../../../packages/contracts/src/settingsUiApi';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { buildSmartTasksWidgetPayload } from './smartTasksWidgetPayload';
import type { SmartTasksWidgetPayload } from './smartTasksWidgetTypes';

type WidgetApiApp = {
  getDeferredObjectiveActivePlansUiPayload?: () => DeferredObjectiveActivePlansV1 | null;
  getDeferredObjectivePlanHistoryUiPayload?: () => SettingsUiDeferredObjectivePlanHistoryPayload;
  getUiPickerDevices?: () => TargetDeviceSnapshot[];
};

type WidgetApiContext = {
  homey: {
    app?: WidgetApiApp;
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
  const activePlans = typeof app?.getDeferredObjectiveActivePlansUiPayload === 'function'
    ? app.getDeferredObjectiveActivePlansUiPayload()
    : null;
  const history = typeof app?.getDeferredObjectivePlanHistoryUiPayload === 'function'
    ? app.getDeferredObjectivePlanHistoryUiPayload()
    : null;
  const devices = typeof app?.getUiPickerDevices === 'function'
    ? app.getUiPickerDevices()
    : [];
  return buildSmartTasksWidgetPayload({
    activePlans,
    history,
    devices,
    nowMs: Date.now(),
    timeZone: readTimeZone(homey),
  });
};
