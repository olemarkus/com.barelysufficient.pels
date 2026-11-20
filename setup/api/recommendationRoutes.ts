import { acknowledgeRecommendation } from '../../lib/app/recommendationAcknowledgement';
import { readCarAssociationCandidatesFromHomey } from '../../lib/device/settingsUiDeviceReads';
import type { SettingsUiRecommendationCarsRead } from '../../packages/contracts/src/settingsUi/carLink';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const recommendationRoutes = defineRoutes({
  ui_recommendation_acknowledge: ({ homey, body }: ApiContext & { body?: unknown }) => (
    acknowledgeRecommendation(homey.settings, body)
  ),
  ui_recommendation_cars: ({ homey }: ApiContext): SettingsUiRecommendationCarsRead => (
    readCarAssociationCandidatesFromHomey(homey)
  ),
});
