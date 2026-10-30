import {
  createSettingsUiStarvationRescue,
  previewSettingsUiStarvationRescue,
} from '../settingsUiStarvationRescueApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const starvationRescueRoutes = defineRoutes({
  ui_starvation_rescue_preview: ({ homey, body }: ApiContext & { body?: unknown }) => (
    previewSettingsUiStarvationRescue({ homey, body })
  ),
  ui_starvation_rescue_create: ({ homey, body }: ApiContext & { body?: unknown }) => (
    createSettingsUiStarvationRescue({ homey, body })
  ),
});
