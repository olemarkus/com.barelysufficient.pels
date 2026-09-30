import type {
  SettingsUiRecommendationCar,
  SettingsUiRecommendationCarsRead,
} from '../../../contracts/src/settingsUiApi.ts';

/** Validate the API envelope; the backend owns car eligibility. */
export const parseCarAssociationCandidatesRead = (value: unknown): SettingsUiRecommendationCarsRead => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { state: 'unavailable' };
  const read = value as Record<string, unknown>;
  if (read.state === 'unavailable') return { state: 'unavailable' };
  if (read.state !== 'resolved' || !Array.isArray(read.cars)) return { state: 'unavailable' };
  if (!read.cars.every((car) => (
    typeof car === 'object'
    && car !== null
    && typeof (car as Record<string, unknown>).id === 'string'
    && typeof (car as Record<string, unknown>).name === 'string'
  ))) return { state: 'unavailable' };
  return { state: 'resolved', cars: read.cars as SettingsUiRecommendationCar[] };
};
