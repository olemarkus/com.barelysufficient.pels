import {
  getSettingsUiDeferredObjectivePlanHistoryPayload,
  getSettingsUiDeferredObjectiveSettingsPayload,
} from '../settingsUiApi';
import {
  cancelSettingsUiSmartTask,
  createSettingsUiSmartTask,
  getSettingsUiSmartTaskDevices,
  previewSettingsUiNewSmartTask,
  previewSettingsUiSmartTask,
  updateSettingsUiSmartTask,
} from '../settingsUiSmartTaskApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

type BodyContext = ApiContext & { body?: unknown };

export const smartTaskRoutes = defineRoutes({
  ui_deferred_objective_history: ({ homey }: ApiContext) => (
    getSettingsUiDeferredObjectivePlanHistoryPayload({ homey })
  ),
  ui_deferred_objective_settings: ({ homey }: ApiContext) => getSettingsUiDeferredObjectiveSettingsPayload({ homey }),
  ui_smart_task_preview: ({ homey, body }: BodyContext) => previewSettingsUiSmartTask({ homey, body }),
  ui_smart_task_devices: ({ homey }: ApiContext) => getSettingsUiSmartTaskDevices({ homey }),
  ui_smart_task_create: ({ homey, body }: BodyContext) => createSettingsUiSmartTask({ homey, body }),
  ui_smart_task_create_preview: ({ homey, body }: BodyContext) => previewSettingsUiNewSmartTask({ homey, body }),
  ui_smart_task_update: ({ homey, body }: BodyContext) => updateSettingsUiSmartTask({ homey, body }),
  ui_smart_task_cancel: ({ homey, body }: BodyContext) => cancelSettingsUiSmartTask({ homey, body }),
});
