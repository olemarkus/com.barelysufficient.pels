import { getSettingsUiHomesPayload, saveSettingsUiHomesConfig } from '../settingsUiHomesApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const homesRoutes = defineRoutes({
  ui_homes: ({ homey }: ApiContext) => getSettingsUiHomesPayload({ homey }),
  ui_homes_save: ({ homey, body }: ApiContext & { body?: unknown }) => saveSettingsUiHomesConfig({ homey, body }),
});
