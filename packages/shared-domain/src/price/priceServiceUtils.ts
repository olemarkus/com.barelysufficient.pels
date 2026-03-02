type SpotPriceCacheDecisionParams = {
  cachedArea: unknown;
  priceArea: string;
  existingPrices: Array<{ startsAt?: string }> | null;
  dates: { todayStr: string; tomorrowStr: string };
  now: Date;
};

type SpotPriceCacheDecision = {
  useCache: boolean;
  shouldFetchTomorrow: boolean;
  areaChanged: boolean;
};

export const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

export const getSpotPriceDates = (today: Date): { todayStr: string; tomorrowStr: string } => {
  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = addDays(today, 1).toISOString().split('T')[0];
  return { todayStr, tomorrowStr };
};

const shouldFetchTomorrowPrices = (now: Date, hasTomorrowPrices: boolean): boolean => {
  const currentHourUtc = now.getUTCHours();
  const currentMinuteUtc = now.getUTCMinutes();
  const isAfter1215Utc = currentHourUtc > 12 || (currentHourUtc === 12 && currentMinuteUtc >= 15);
  return isAfter1215Utc && !hasTomorrowPrices;
};

export const getSpotPriceCacheDecision = (params: SpotPriceCacheDecisionParams): SpotPriceCacheDecision => {
  const { cachedArea, priceArea, existingPrices, dates, now } = params;
  const areaChanged = typeof cachedArea === 'string' && cachedArea !== priceArea;
  if (!existingPrices || !Array.isArray(existingPrices) || existingPrices.length === 0 || areaChanged) {
    return { useCache: false, shouldFetchTomorrow: false, areaChanged };
  }

  const hasTodayPrices = existingPrices.some((p) => p.startsAt?.startsWith(dates.todayStr));
  const hasTomorrowPrices = existingPrices.some((p) => p.startsAt?.startsWith(dates.tomorrowStr));
  const shouldFetchTomorrow = shouldFetchTomorrowPrices(now, hasTomorrowPrices);
  const useCache = hasTodayPrices && !shouldFetchTomorrow;
  return { useCache, shouldFetchTomorrow, areaChanged };
};

export const subtractMonths = (date: Date, months: number): Date => {
  const target = new Date(date);
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() - months);
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, daysInMonth));
  return target;
};

export const buildGridTariffFallbackDates = (baseDate: Date): Array<{ label: string; date: Date }> => {
  const yesterday = new Date(baseDate);
  yesterday.setDate(yesterday.getDate() - 1);

  const weekAgo = new Date(baseDate);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const monthAgo = subtractMonths(baseDate, 1);

  return [
    { label: 'yesterday', date: yesterday },
    { label: 'week', date: weekAgo },
    { label: 'month', date: monthAgo },
  ];
};
