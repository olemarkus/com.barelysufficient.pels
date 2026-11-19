import { isUnknownRecord } from '../recordGuards';

export const SETUP_RECOMMENDATION_DISMISSALS = 'setup_recommendation_dismissals';
export type RecommendationDismissals = Record<string, number>;

export const isRecommendationVersion = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);

export const normalizeRecommendationDismissals = (value: unknown): RecommendationDismissals => {
  if (!isUnknownRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => (
    isRecommendationVersion(entry[1])
  )));
};
