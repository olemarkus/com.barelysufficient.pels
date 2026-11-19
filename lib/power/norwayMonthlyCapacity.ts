import type {
  NorwayMonthlyCapacityRead, NorwayRemainingMonthCap, NorwayHardCapRecommendation,
} from '../../packages/contracts/src/norwayMonthlyCapacity';
import type { NorwayCapacityTariff } from '../../packages/contracts/src/norwayCapacityTariff';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import {
  getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey,
} from '../../packages/shared-domain/src/utils/dateUtils';
import { NORWAY_BILLING_ZONE, norwayMonthKey, type NorwayMonthHistory } from './norwayMonthlyCapacityHistory';

const BUFFER_KW = 0.05;
const topThree = (values: readonly number[]): number[] => [...values].sort((a, b) => b - a).slice(0, 3);
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const tierIndex = (tariff: NorwayCapacityTariff, kw: number): number => {
  const reversed = [...tariff.boundariesKw].reverse();
  const index = reversed.findIndex((boundary) => tariff.thresholdIncluded ? kw >= boundary : kw > boundary);
  return Math.max(0, tariff.boundariesKw.length - 1 - (index < 0 ? tariff.boundariesKw.length - 1 : index));
};

const futurePeakSum = (month: NorwayMonthHistory, nowMs: number, candidate: number): number => {
  const today = getDateKeyInTimeZone(new Date(nowMs), NORWAY_BILLING_ZONE);
  const previous = month.peaks;
  const values = previous.filter((peak) => peak.dateKey !== today).map((peak) => peak.kw);
  const todayPeak = previous.find((peak) => peak.dateKey === today)?.kw ?? 0;
  // Local worst-case scenario, never shared with a caller.
  values.push(Math.max(todayPeak, candidate)); // eslint-disable-line functional/immutable-data
  for (let day = shiftDateKey(today, 1); day.startsWith(month.monthKey); day = shiftDateKey(day, 1)) {
    values.push(candidate); // eslint-disable-line functional/immutable-data -- Local worst-case scenario.
  }
  return sum(topThree(values));
};

/** Oslo-month start, including its daylight-saving offset. */
export const norwayMonthStartMs = (nowMs: number): number => (
  getDateKeyStartMs(`${norwayMonthKey(nowMs)}-01`, NORWAY_BILLING_ZONE)
);

const safeCandidate = (
  month: NorwayMonthHistory, ceiling: number | undefined,
  canSuggest: boolean, nowMs: number, thresholdIncluded: boolean,
): number => {
  if (ceiling === undefined || !canSuggest) return 0;
  const maxStep = Math.floor((ceiling - BUFFER_KW) * 10 + 1e-9);
  for (let step = maxStep; step > 0; step -= 1) {
    const value = step / 10;
    const futureSum = futurePeakSum(month, nowMs, value + BUFFER_KW);
    if (thresholdIncluded ? futureSum < 3 * ceiling : futureSum <= 3 * ceiling) return value;
  }
  return 0;
};

type ReadyRead = Extract<NorwayMonthlyCapacityRead, { state: 'ready' }>;
const measuredFacts = (
  month: NorwayMonthHistory, tariff: NorwayCapacityTariff,
): Omit<ReadyRead, 'targetBoundaryKw' | 'targetLost' | 'advice' | 'remainingMonthCap' | 'hardCapRecommendation'> => {
  const peaks = [...month.peaks].sort((a, b) => b.kw - a.kw).slice(0, 3);
  const currentIndex = tierIndex(tariff, sum(peaks.map((peak) => peak.kw)) / 3);
  return {
    state: 'ready', monthKey: month.monthKey, tariffIdentity: tariff.identity,
    coverage: month.coverage,
    peaks, average: peaks.length < 3 ? { state: 'collecting', days: peaks.length }
      : { state: 'recorded', kw: sum(peaks.map((peak) => peak.kw)) / 3 },
    tier: { lowerKw: tariff.boundariesKw[currentIndex] ?? 0, upperKw: tariff.boundariesKw[currentIndex + 1] ?? null },
  };
};

const remainingCap = (
  candidate: number, ceiling: number | undefined, canSuggest: boolean, appliedLimitKw: number,
): NorwayRemainingMonthCap => {
  if (ceiling === undefined) return { state: 'unbounded_tier' };
  if (!canSuggest) return { state: 'keep_current', limitKw: appliedLimitKw };
  return candidate > 0 ? { state: 'bounded', limitKw: candidate } : { state: 'no_positive_limit' };
};

const hardCapRecommendation = (
  remaining: NorwayRemainingMonthCap, scalars: CapacityScalarSettings, appliedLimitKw: number, targetLost: boolean,
): NorwayHardCapRecommendation => {
  if (remaining.state !== 'bounded') return { state: 'none' };
  const unchanged = Math.abs(remaining.limitKw - appliedLimitKw) < 1e-9;
  const keepLower = !targetLost && appliedLimitKw <= remaining.limitKw;
  return unchanged || keepLower
    ? { state: 'keep', limitKw: appliedLimitKw, marginKw: scalars.marginKw }
    : { state: 'set', limitKw: remaining.limitKw, marginKw: scalars.marginKw };
};

/** Exact measured quantities stay in the owner; the browser only formats this result. */
export const resolveNorwayMonthlyCapacity = (
  month: NorwayMonthHistory,
  tariff: NorwayCapacityTariff,
  scalars: CapacityScalarSettings,
  appliedLimitKw: number,
  nowMs: number,
): NorwayMonthlyCapacityRead => {
  const facts = measuredFacts(month, tariff);
  const lowerSum = sum(topThree(month.peaks.map((peak) => peak.kw)));
  const targetIndex = tariff.boundariesKw.findIndex((boundary) => boundary >= scalars.limitKw && boundary > 0);
  const targetBoundaryKw = tariff.boundariesKw[targetIndex];
  if (targetBoundaryKw === undefined) return {
    ...facts, targetBoundaryKw: null, targetLost: false, advice: { state: 'none' },
    remainingMonthCap: { state: 'unbounded_tier' }, hardCapRecommendation: { state: 'none' },
  };
  const targetLost = tariff.thresholdIncluded ? lowerSum >= 3 * targetBoundaryKw : lowerSum > 3 * targetBoundaryKw;
  const lossBuffered = lowerSum >= 3 * (targetBoundaryKw + BUFFER_KW);
  const protectIndex = targetLost ? Math.max(targetIndex, tierIndex(tariff, lowerSum / 3)) : targetIndex - 1;
  const ceiling = tariff.boundariesKw[protectIndex + 1];
  const complete = facts.coverage === 'complete';
  const candidate = safeCandidate(
    month, ceiling, !targetLost || lossBuffered, nowMs, tariff.thresholdIncluded,
  );
  // A Hard cap at the tier step is what Limits asks for; only recorded peaks justify a lower one.
  const peaksBind = candidate < safeCandidate(
    { ...month, peaks: [] }, ceiling, !targetLost || lossBuffered, nowMs, tariff.thresholdIncluded,
  );
  const stepCap = !targetLost && !peaksBind && ceiling !== undefined
    && appliedLimitKw > candidate && appliedLimitKw <= ceiling;
  const remainingMonthCap = stepCap ? { state: 'bounded' as const, limitKw: appliedLimitKw }
    : remainingCap(candidate, ceiling, !targetLost || lossBuffered, appliedLimitKw);
  const recommendation = hardCapRecommendation(remainingMonthCap, scalars, appliedLimitKw, targetLost);
  const advice = recommendation.state === 'set'
    ? {
      state: 'suggestion' as const, limitKw: recommendation.limitKw,
      version: `${month.monthKey}:${tariff.identity}:${scalars.limitKw}:${scalars.marginKw}:${recommendation.limitKw}`,
      direction: recommendation.limitKw > appliedLimitKw ? 'raise' as const : 'lower' as const,
      actionable: complete || recommendation.limitKw < appliedLimitKw,
    } : { state: 'none' as const };
  return { ...facts, targetBoundaryKw, targetLost, remainingMonthCap, hardCapRecommendation: recommendation, advice };

};
