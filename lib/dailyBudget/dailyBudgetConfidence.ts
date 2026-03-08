import type { PowerTrackerState } from '../core/powerTracker';
import {
  buildLocalDayBuckets,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';
import { clamp } from '../utils/mathUtils';
import { hasUnreliableOverlap } from './dailyBudgetLearning';
import type { ConfidenceDebug } from './dailyBudgetTypes';

const LOOKBACK_DAYS = 30;
const RAMP_DAYS = 14;
const BOOTSTRAP_ITERATIONS = 500;
const BOOTSTRAP_SEED = 42;
const HOURS = 24;
const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;

const ZEROS_24 = (): number[] => Array(HOURS).fill(0);

const UNIFORM_24 = (): number[] => Array(HOURS).fill(1 / HOURS);

type DayData = {
  dateKey: string;
  totalProfile: number[];
  plannedProfile: number[] | null;
  controlledShare: number;
};

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export type ConfidenceResult = {
  confidence: number;
  debug: ConfidenceDebug;
};

function createEmptyConfidenceDebug(profileBlendConfidence: number): ConfidenceDebug {
  return {
    confidenceRegularity: 0,
    confidenceAdaptability: 0,
    confidenceAdaptabilityInfluence: 0,
    confidenceWeightedControlledShare: 0,
    confidenceValidActualDays: 0,
    confidenceValidPlannedDays: 0,
    confidenceBootstrapLow: 0,
    confidenceBootstrapHigh: 0,
    profileBlendConfidence,
  };
}

function createEmptyConfidenceResult(profileBlendConfidence: number): ConfidenceResult {
  return {
    confidence: 0,
    debug: createEmptyConfidenceDebug(profileBlendConfidence),
  };
}

export function computeBacktestedConfidence(params: {
  nowMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
  profileBlendConfidence: number;
  includeBootstrapDebug?: boolean;
}): ConfidenceResult {
  const {
    nowMs,
    timeZone,
    powerTracker,
    profileBlendConfidence,
    includeBootstrapDebug = false,
  } = params;
  const days = collectValidDays({ nowMs, timeZone, powerTracker });

  if (days.length === 0) {
    return createEmptyConfidenceResult(profileBlendConfidence);
  }

  const regularity = computeRegularityScore(days);
  const adaptability = computeAdaptabilityScore(days, regularity.centroid);
  const confidence = combineScores({
    regularityScore: regularity.score,
    adaptabilityScore: adaptability.score,
    adaptabilityInfluence: adaptability.influence,
  });
  const bootstrap = includeBootstrapDebug
    ? computeBootstrapInterval(days)
    : { low: confidence, high: confidence };

  return {
    confidence,
    debug: {
      confidenceRegularity: regularity.score,
      confidenceAdaptability: adaptability.score,
      confidenceAdaptabilityInfluence: adaptability.influence,
      confidenceWeightedControlledShare: adaptability.weightedControlledShare,
      confidenceValidActualDays: days.length,
      confidenceValidPlannedDays: adaptability.validPlannedDays,
      confidenceBootstrapLow: bootstrap.low,
      confidenceBootstrapHigh: bootstrap.high,
      profileBlendConfidence,
    },
  };
}

function collectValidDays(params: {
  nowMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
}): DayData[] {
  const { nowMs, timeZone, powerTracker } = params;
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const days: DayData[] = [];
  const seen = new Set<string>();

  let currentDayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);

  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const prevDayStartUtcMs = getPreviousLocalDayStartUtcMs(currentDayStartUtcMs, timeZone);
    const dateKey = getDateKeyInTimeZone(new Date(prevDayStartUtcMs), timeZone);
    currentDayStartUtcMs = prevDayStartUtcMs;

    if (seen.has(dateKey)) continue;
    seen.add(dateKey);

    const dayData = buildDayData({ prevDayStartUtcMs, dateKey, timeZone, powerTracker });
    if (dayData) days.push(dayData);
  }

  return days;
}

function buildDayData(params: {
  prevDayStartUtcMs: number;
  dateKey: string;
  timeZone: string;
  powerTracker: PowerTrackerState;
}): DayData | null {
  const { prevDayStartUtcMs, dateKey, timeZone, powerTracker } = params;
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(prevDayStartUtcMs, timeZone);

  if (hasUnreliableOverlap({
    startUtcMs: prevDayStartUtcMs,
    endUtcMs: nextDayStartUtcMs,
    unreliablePeriods: powerTracker.unreliablePeriods,
  })) {
    return null;
  }

  const { bucketStartUtcMs } = buildLocalDayBuckets({
    dayStartUtcMs: prevDayStartUtcMs,
    nextDayStartUtcMs,
    timeZone,
  });

  const hourly = aggregateHourlyBins(bucketStartUtcMs, timeZone, powerTracker);
  const totalUsage = hourly.total.reduce((sum, v) => sum + v, 0);
  if (totalUsage <= 0) return null;

  const totalControlled = hourly.controlled.reduce((sum, v) => sum + v, 0);
  return {
    dateKey,
    totalProfile: normalizeProfile(hourly.total),
    plannedProfile: hourly.hasPlanData ? normalizeProfile(hourly.planned) : null,
    controlledShare: clamp(totalControlled / totalUsage, 0, 1),
  };
}

function aggregateHourlyBins(
  bucketStartUtcMs: number[],
  timeZone: string,
  powerTracker: PowerTrackerState,
): { total: number[]; controlled: number[]; planned: number[]; hasPlanData: boolean } {
  const total = ZEROS_24();
  const controlled = ZEROS_24();
  const planned = ZEROS_24();
  let planBucketCount = 0;

  const totalBuckets = powerTracker.buckets ?? {};
  const controlledBuckets = powerTracker.controlledBuckets ?? {};
  const dailyBudgetCaps = powerTracker.dailyBudgetCaps ?? {};

  for (const ts of bucketStartUtcMs) {
    const isoKey = new Date(ts).toISOString();
    const hour = getZonedParts(new Date(ts), timeZone).hour;
    const totalVal = totalBuckets[isoKey];
    if (typeof totalVal === 'number' && Number.isFinite(totalVal)) {
      const boundedTotalVal = Math.max(0, totalVal);
      total[hour] += boundedTotalVal;
      const controlledVal = controlledBuckets[isoKey];
      if (typeof controlledVal === 'number' && Number.isFinite(controlledVal)) {
        controlled[hour] += clamp(controlledVal, 0, boundedTotalVal);
      }
    }
    const cap = dailyBudgetCaps[isoKey];
    if (typeof cap === 'number' && Number.isFinite(cap)) {
      planned[hour] += Math.max(0, cap);
      planBucketCount++;
    }
  }

  const hasPlanData = planBucketCount >= bucketStartUtcMs.length * 0.9;
  return { total, controlled, planned, hasPlanData };
}

function getPreviousLocalDayStartUtcMs(dayStartUtcMs: number, timeZone: string): number {
  const prevCandidate = new Date(dayStartUtcMs - 22 * 60 * 60 * 1000);
  const prevKey = getDateKeyInTimeZone(prevCandidate, timeZone);
  return getDateKeyStartMs(prevKey, timeZone);
}

function normalizeProfile(profile: number[]): number[] {
  const sum = profile.reduce((s, v) => s + v, 0);
  if (sum <= 0) return UNIFORM_24();
  return profile.map((v) => v / sum);
}

function l1Distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum;
}

function computeCentroid(days: DayData[]): number[] {
  const n = days.length;
  const centroid = ZEROS_24();
  for (const day of days) {
    for (let h = 0; h < HOURS; h++) {
      centroid[h] += day.totalProfile[h];
    }
  }
  for (let h = 0; h < HOURS; h++) {
    centroid[h] /= n;
  }
  return centroid;
}

function computeRegularityScore(days: DayData[]): {
  score: number;
  dayScores: number[];
  centroid: number[];
} {
  const n = days.length;
  if (n === 0) return { score: 0, dayScores: [], centroid: UNIFORM_24() };

  if (n === 1) {
    const ramp = clamp(1 / RAMP_DAYS, 0, 1);
    return { score: ramp, dayScores: [1], centroid: days[0].totalProfile };
  }

  const centroid = computeCentroid(days);
  const totalProfile = centroid.map((value) => value * n);

  const dayScores: number[] = [];
  for (let i = 0; i < n; i++) {
    let dist = 0;
    for (let h = 0; h < HOURS; h++) {
      const looValue = (totalProfile[h]! - days[i].totalProfile[h]!) / (n - 1);
      dist += Math.abs(days[i].totalProfile[h]! - looValue);
    }
    dayScores.push(clamp(1 - dist / 2, 0, 1));
  }

  const meanScore = dayScores.reduce((s, v) => s + v, 0) / n;
  const ramp = clamp(n / RAMP_DAYS, 0, 1);
  return { score: meanScore * ramp, dayScores, centroid };
}

function computeAdaptabilityScore(days: DayData[], centroid: number[]): {
  score: number;
  influence: number;
  weightedControlledShare: number;
  validPlannedDays: number;
} {
  const daysWithPlans = days.filter((d) => d.plannedProfile !== null);
  if (daysWithPlans.length === 0) {
    return { score: 0, influence: 0, weightedControlledShare: 0, validPlannedDays: 0 };
  }

  let weightedScoreSum = 0;
  let weightSum = 0;
  let shiftDemandSum = 0;
  let weightedShareSum = 0;
  let weightedDayCount = 0;

  for (const day of daysWithPlans) {
    const plannedProfile = day.plannedProfile!;
    const shiftDemand = Math.max(0.20, l1Distance(plannedProfile, centroid) / 2);
    const weight = day.controlledShare * shiftDemand;
    shiftDemandSum += shiftDemand;
    weightedShareSum += day.controlledShare * shiftDemand;

    if (weight <= 0) continue;

    const planFit = clamp(1 - l1Distance(day.totalProfile, plannedProfile) / 2, 0, 1);
    weightedScoreSum += planFit * weight;
    weightSum += weight;
    weightedDayCount++;
  }

  if (weightSum <= 0 || shiftDemandSum <= 0) {
    return {
      score: 0, influence: 0, weightedControlledShare: 0,
      validPlannedDays: 0,
    };
  }

  const ramp = clamp(weightedDayCount / RAMP_DAYS, 0, 1);
  const score = (weightedScoreSum / weightSum) * ramp;
  const weightedControlledShare = weightedShareSum / shiftDemandSum;
  const influence = clamp(weightedControlledShare * 1.2, 0, 0.85);

  return {
    score,
    influence,
    weightedControlledShare,
    validPlannedDays: weightedDayCount,
  };
}

function computeBootstrapInterval(days: DayData[]): { low: number; high: number } {
  const n = days.length;
  if (n === 0) return { low: 0, high: 0 };

  const nextRandom = createSeededRandom(BOOTSTRAP_SEED);

  const scores: number[] = [];
  for (let iter = 0; iter < BOOTSTRAP_ITERATIONS; iter++) {
    const sampledDays = sampleDays(days, nextRandom);
    const regularity = computeRegularityScore(sampledDays);
    const adaptability = computeAdaptabilityScore(sampledDays, regularity.centroid);
    scores.push(combineScores({
      regularityScore: regularity.score,
      adaptabilityScore: adaptability.score,
      adaptabilityInfluence: adaptability.influence,
    }));
  }

  scores.sort((a, b) => a - b);
  const lowIdx = Math.floor(scores.length * 0.05);
  const highIdx = Math.floor(scores.length * 0.95);
  return {
    low: clamp(scores[lowIdx], 0, 1),
    high: clamp(scores[highIdx], 0, 1),
  };
}

function createSeededRandom(initialSeed: number): () => number {
  let seed = initialSeed;
  return () => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

export function sampleDayIndex(randomValue: number, dayCount: number): number {
  return Math.min(dayCount - 1, Math.max(0, Math.floor(randomValue * dayCount)));
}

function sampleDays(days: DayData[], nextRandom: () => number): DayData[] {
  return days.map(() => {
    const idx = sampleDayIndex(nextRandom(), days.length);
    return days[idx]!;
  });
}

function getConfidenceWindowBounds(nowMs: number, timeZone: string): {
  dayStartUtcMs: number;
  windowStartUtcMs: number;
} {
  const todayKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const dayStartUtcMs = getDateKeyStartMs(todayKey, timeZone);
  let windowStartUtcMs = dayStartUtcMs;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    windowStartUtcMs = getPreviousLocalDayStartUtcMs(windowStartUtcMs, timeZone);
  }
  return { dayStartUtcMs, windowStartUtcMs };
}

function appendHashString(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let i = 0; i < value.length; i++) {
    next ^= value.charCodeAt(i);
    next = Math.imul(next, FNV_PRIME) >>> 0;
  }
  return next;
}

function appendHashNumber(hash: number, value: number): number {
  return appendHashString(hash, Number.isFinite(value) ? value.toString() : 'NaN');
}

function appendRecordFingerprint(
  hash: number,
  label: string,
  record: Record<string, number> | undefined,
  windowStartUtcMs: number,
  dayStartUtcMs: number,
): number {
  let next = appendHashString(hash, label);
  if (!record) return next;
  const relevantKeys = Object.keys(record)
    .filter((key) => {
      const ts = Date.parse(key);
      return Number.isFinite(ts) && ts >= windowStartUtcMs && ts < dayStartUtcMs;
    })
    .sort();
  for (const key of relevantKeys) {
    next = appendHashString(next, key);
    next = appendHashNumber(next, record[key]!);
  }
  return next;
}

function appendUnreliablePeriodsFingerprint(
  hash: number,
  unreliablePeriods: PowerTrackerState['unreliablePeriods'],
  windowStartUtcMs: number,
  dayStartUtcMs: number,
): number {
  let next = appendHashString(hash, 'u');
  const relevantPeriods = (unreliablePeriods ?? [])
    .filter((period) => period.end > windowStartUtcMs && period.start < dayStartUtcMs)
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  for (const period of relevantPeriods) {
    next = appendHashNumber(next, period.start);
    next = appendHashNumber(next, period.end);
  }
  return next;
}

function buildConfidenceInputKey(params: {
  nowMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
  dateKey: string;
}): string {
  const {
    nowMs,
    timeZone,
    powerTracker,
    dateKey,
  } = params;
  const { dayStartUtcMs, windowStartUtcMs } = getConfidenceWindowBounds(nowMs, timeZone);
  let hash = FNV_OFFSET_BASIS;
  hash = appendHashString(hash, timeZone);
  hash = appendHashString(hash, dateKey);
  hash = appendRecordFingerprint(hash, 'b', powerTracker.buckets, windowStartUtcMs, dayStartUtcMs);
  hash = appendRecordFingerprint(hash, 'c', powerTracker.controlledBuckets, windowStartUtcMs, dayStartUtcMs);
  hash = appendRecordFingerprint(hash, 'p', powerTracker.dailyBudgetCaps, windowStartUtcMs, dayStartUtcMs);
  hash = appendUnreliablePeriodsFingerprint(hash, powerTracker.unreliablePeriods, windowStartUtcMs, dayStartUtcMs);
  return hash.toString(16);
}

function withProfileBlendConfidence(
  result: ConfidenceResult,
  profileBlendConfidence: number,
): ConfidenceResult {
  if (result.debug.profileBlendConfidence === profileBlendConfidence) return result;
  return {
    ...result,
    debug: {
      ...result.debug,
      profileBlendConfidence,
    },
  };
}

function combineScores(params: {
  regularityScore: number;
  adaptabilityScore: number;
  adaptabilityInfluence: number;
}): number {
  const { regularityScore, adaptabilityScore, adaptabilityInfluence } = params;
  const w = clamp(adaptabilityInfluence, 0, 1);
  const combined = regularityScore * (1 - w) + adaptabilityScore * w;
  return clamp(combined, 0, 1);
}

export type ConfidenceCache = {
  result: ConfidenceResult | null;
  lastMs: number;
  lastInputKey: string | null;
  bootstrapComplete: boolean;
};

export function createConfidenceCache(): ConfidenceCache {
  return { result: null, lastMs: 0, lastInputKey: null, bootstrapComplete: false };
}

export function getCachedConfidence(params: {
  cache: ConfidenceCache;
  profileBlendConfidence: number;
}): ConfidenceResult {
  const { cache, profileBlendConfidence } = params;
  if (!cache.result) return createEmptyConfidenceResult(profileBlendConfidence);
  return withProfileBlendConfidence(cache.result, profileBlendConfidence);
}

export function resolveConfidence(params: {
  cache: ConfidenceCache;
  nowMs: number;
  timeZone: string;
  powerTracker: PowerTrackerState;
  profileBlendConfidence: number;
  dateKey: string;
  includeBootstrapDebug?: boolean;
}): ConfidenceResult {
  const {
    cache,
    nowMs,
    timeZone,
    powerTracker,
    profileBlendConfidence,
    dateKey,
    includeBootstrapDebug = false,
  } = params;
  const elapsed = nowMs - cache.lastMs;
  const inputKey = buildConfidenceInputKey({
    nowMs,
    timeZone,
    powerTracker,
    dateKey,
  });
  const canReuseCachedResult = cache.result
    && inputKey === cache.lastInputKey
    && elapsed < RECOMPUTE_INTERVAL_MS
    && (includeBootstrapDebug === false || cache.bootstrapComplete);
  if (canReuseCachedResult) {
    return withProfileBlendConfidence(cache.result as ConfidenceResult, profileBlendConfidence);
  }
  const result = computeBacktestedConfidence({
    nowMs,
    timeZone,
    powerTracker,
    profileBlendConfidence,
    includeBootstrapDebug,
  });
  Object.assign(cache, {
    result,
    lastMs: nowMs,
    lastInputKey: inputKey,
    bootstrapComplete: includeBootstrapDebug,
  });
  return result;
}
