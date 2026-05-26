import type { DeferredObjectiveActivePlansV1 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { buildSmartTasksWidgetPayload } from './smartTasksWidgetPayload';
import type { SmartTasksWidgetPayload } from './smartTasksWidgetTypes';

type WidgetApiApp = {
  getDeferredObjectiveActivePlansUiPayload?: () => DeferredObjectiveActivePlansV1 | null;
  getUiPickerDevices?: () => TargetDeviceSnapshot[];
};

type WidgetApiContext = {
  homey: {
    app?: WidgetApiApp;
  };
};

export const getSmartTasks = async ({ homey }: WidgetApiContext): Promise<SmartTasksWidgetPayload> => {
  const app = homey.app;
  const activePlans = typeof app?.getDeferredObjectiveActivePlansUiPayload === 'function'
    ? app.getDeferredObjectiveActivePlansUiPayload()
    : null;
  const devices = typeof app?.getUiPickerDevices === 'function'
    ? app.getUiPickerDevices()
    : [];
  return buildSmartTasksWidgetPayload({
    activePlans,
    devices,
    nowMs: Date.now(),
  });
};
