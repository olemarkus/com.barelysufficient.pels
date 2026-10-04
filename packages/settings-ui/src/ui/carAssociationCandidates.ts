import type {
  SettingsUiRecommendationCar,
  SettingsUiRecommendationCarsRead,
} from '../../../contracts/src/settingsUiApi.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isChargerMatch = (value: unknown): boolean => (
  isRecord(value)
  && typeof value.chargerId === 'string'
  && typeof value.lastMatchedAtMs === 'number'
  && Number.isFinite(value.lastMatchedAtMs)
);

const isMatchHistory = (value: unknown): boolean => (
  isRecord(value)
  && (value.state === 'unavailable'
    || (value.state === 'resolved'
      && Array.isArray(value.chargerMatches)
      && value.chargerMatches.every(isChargerMatch)))
);

const isRecommendationCar = (value: unknown): value is SettingsUiRecommendationCar => (
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.name === 'string'
  && isMatchHistory(value.matchHistory)
);

/** Validate the API envelope; the backend owns car eligibility. */
export const parseCarAssociationCandidatesRead = (value: unknown): SettingsUiRecommendationCarsRead => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { state: 'unavailable' };
  const read = value as Record<string, unknown>;
  if (read.state === 'unavailable') return { state: 'unavailable' };
  if (read.state !== 'resolved' || !Array.isArray(read.cars)) return { state: 'unavailable' };
  if (!read.cars.every(isRecommendationCar)) return { state: 'unavailable' };
  return { state: 'resolved', cars: read.cars };
};
