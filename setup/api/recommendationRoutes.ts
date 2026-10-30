import { readCarAssociationCandidatesFromHomey } from '../../lib/device/settingsUiDeviceReads';
import type { SettingsUiRecommendationCarsRead } from '../../packages/contracts/src/settingsUiApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const recommendationRoutes = defineRoutes({
  ui_recommendation_cars: ({ homey }: ApiContext): SettingsUiRecommendationCarsRead => (
    readCarAssociationCandidatesFromHomey(homey)
  ),
});
