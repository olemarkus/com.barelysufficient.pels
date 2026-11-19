import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import {
  isRecommendationVersion, normalizeRecommendationDismissals, SETUP_RECOMMENDATION_DISMISSALS,
} from '../../packages/shared-domain/src/settings/recommendationDismissals';
import type { SettingsPort } from '../ports/homeyRuntime';
import { ApiRequestError } from '../utils/apiRequestError';

const isOptionalVersion = (value: unknown): value is number | null => value === null || isRecommendationVersion(value);

/** Apply one card's choice without yielding between the read and write. */
export const acknowledgeRecommendation = (settings: SettingsPort, body: unknown): Record<string, number> => {
  if (!isUnknownRecord(body) || typeof body.id !== 'string' || body.id.length > 2048
    || !/^[\w-]+:.+$/u.test(body.id)
    || !isOptionalVersion(body.version)
    || !isOptionalVersion(body.expectedVersion)) {
    throw new ApiRequestError('Invalid recommendation acknowledgement.');
  }
  const raw = settings.get(SETUP_RECOMMENDATION_DISMISSALS);
  if (!isUnknownRecord(raw) && (raw != null || settings.getKeys().includes(SETUP_RECOMMENDATION_DISMISSALS))) {
    throw new Error('Saved recommendations could not be read.');
  }
  const current = normalizeRecommendationDismissals(raw);
  const previous = current[body.id] ?? null;
  // Versions can be cap values or episode times. A stale session may change
  // only the version it saw, even when the next cap is a smaller number.
  if (previous === body.version || previous !== body.expectedVersion) return current;
  const next = body.version === null
    ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== body.id))
    : { ...current, [body.id]: body.version };
  settings.set(SETUP_RECOMMENDATION_DISMISSALS, next);
  return next;
};
