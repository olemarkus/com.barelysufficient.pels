import type { NorwayMonthlyCapacityRead } from '../../../contracts/src/norwayMonthlyCapacity.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';

const nonnegative = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);
const validPeak = (peak: unknown): boolean => isUnknownRecord(peak)
  && typeof peak.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(peak.dateKey)
  && nonnegative(peak.hourStartMs) && nonnegative(peak.kw)
  && (peak.lowerBound === undefined || peak.lowerBound === true);
const validAverage = (average: unknown): boolean => {
  if (!isUnknownRecord(average)) return false;
  return (average.state === 'collecting' && nonnegative(average.days)
    && Number.isInteger(average.days) && average.days < 3)
    || (average.state === 'recorded' && nonnegative(average.kw));
};
const validAdvice = (advice: unknown): boolean => {
  if (!isUnknownRecord(advice)) return false;
  return advice.state === 'none' || (advice.state === 'suggestion' && nonnegative(advice.limitKw)
    && typeof advice.version === 'string' && ['raise', 'lower'].includes(String(advice.direction))
    && typeof advice.actionable === 'boolean');
};
const validRemainingCap = (cap: unknown): boolean => {
  if (!isUnknownRecord(cap)) return false;
  if (cap.state === 'unbounded_tier' || cap.state === 'no_positive_limit') return true;
  return (cap.state === 'bounded' || cap.state === 'keep_current') && nonnegative(cap.limitKw) && cap.limitKw > 0;
};
const validTier = (tier: unknown): boolean => isUnknownRecord(tier) && nonnegative(tier.lowerKw)
  && (tier.upperKw === null || (nonnegative(tier.upperKw) && tier.upperKw > tier.lowerKw));
const validRecommendation = (recommendation: unknown): boolean => isUnknownRecord(recommendation)
  && (recommendation.state === 'none' || (['set', 'keep'].includes(String(recommendation.state))
    && nonnegative(recommendation.limitKw) && nonnegative(recommendation.marginKw)
    && recommendation.limitKw > recommendation.marginKw));
const validReadyFields = (value: Record<string, unknown>): boolean => (
  typeof value.monthKey === 'string' && /^\d{4}-\d{2}$/.test(value.monthKey)
  && typeof value.tariffIdentity === 'string' && ['complete', 'partial'].includes(String(value.coverage))
  && Array.isArray(value.peaks) && value.peaks.every(validPeak)
  && (value.targetBoundaryKw === null || nonnegative(value.targetBoundaryKw))
  && typeof value.targetLost === 'boolean'
);

/** Classify the untrusted monthly-capacity transport once, before rendering. */
export function classifyNorwayMonthlyCapacity(value: unknown): NorwayMonthlyCapacityRead {
  if (value === undefined) return { state: 'hidden' };
  const unavailable = { state: 'unavailable', reason: 'tariff' } as const;
  if (!isUnknownRecord(value)) return unavailable;
  if (value.state === 'hidden') return { state: 'hidden' };
  if (value.state === 'unavailable' && ['grid_company', 'tariff', 'timezone'].includes(String(value.reason))) {
    return value as NorwayMonthlyCapacityRead;
  }
  if (value.state !== 'ready' || !validReadyFields(value) || !validAverage(value.average)
    || !validTier(value.tier) || !validAdvice(value.advice)
    || !validRemainingCap(value.remainingMonthCap)
    || !validRecommendation(value.hardCapRecommendation)) return unavailable;
  return value as NorwayMonthlyCapacityRead;
}
