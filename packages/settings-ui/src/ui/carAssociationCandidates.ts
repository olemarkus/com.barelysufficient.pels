import type {
  SettingsUiRecommendationCar,
  SettingsUiRecommendationCarsRead,
} from '../../../contracts/src/settingsUiApi.ts';

/**
 * How the charger's car picker and Setup name a selected car that is no longer
 * in Homey: its own name went with it, and the row exists only to be cleared.
 */
export const REMOVED_CAR_LABEL = 'Removed car';

/**
 * Whether a car has matched a charger other than this one that is still among
 * the home's chargers: such a car charges elsewhere and is not about to match
 * here, so the car picker and Setup drop their "yet". The history keeps a match
 * for 90 days, so it can name a charger since removed or replaced; a match to a
 * retired charger leaves this charger its "yet".
 */
export const hasMatchedAnotherCurrentCharger = (
  history: Extract<SettingsUiRecommendationCar['matchHistory'], { state: 'resolved' }>,
  chargerId: string,
  currentChargerIds: ReadonlySet<string>,
): boolean => history.chargerMatches.some((match) => (
  match.chargerId !== chargerId && currentChargerIds.has(match.chargerId)
));

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
