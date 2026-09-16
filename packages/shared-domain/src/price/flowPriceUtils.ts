// The one home for flow price-payload parsing, imported by both the runtime
// price service (`lib/price/**`) and the settings UI. It lives here because
// shared-domain is browser-safe AND ships inside the app bundle: the runtime
// entry points inline `packages/` (scripts/bundle-homey-build.mjs), and
// scripts/sanitize-homey-build.mjs prunes only `packages/contracts`.
//
// This module used to exist twice, hand-synced, on the grounds that merging it
// would breach `no-settings-ui-to-runtime`. That rule forbids settings-ui →
// `lib/**`; it says nothing about `lib/**` → shared-domain, which is the
// direction that merges them and which ~165 runtime files already take.
import {
  buildLocalDayBuckets,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  getZonedParts,
} from '../utils/dateUtils';

/**
 * One priced period. `durationMinutes` is what the period covers: 60 for an
 * hourly source (owner Flow input, Norwegian spot), 15 for a Homey Energy zone
 * publishing quarter-hour prices. It is required so no consumer has to assume a
 * span — an assumed hour over a quarter-hour series silently reads the :00
 * price as the whole hour.
 *
 * Persisted payloads written before periods carried a duration have none; the
 * read boundary (`normalizeFlowSlotEntries`) resolves those to 60, which is
 * what they were.
 */
export type FlowPricePeriod = {
  startsAt: string;
  totalPrice: number;
  durationMinutes: number;
};

export type FlowPricePayload = {
  dateKey: string;
  pricesByHour: Record<string, number>;
  updatedAt: string;
  /**
   * One entry per local hour, at the exact instant that hour starts. Every
   * version of PELS that has ever stored this key has meant exactly that by it,
   * so it keeps meaning it: an older build reinstalled over a payload written
   * here reads the same hourly prices it wrote itself.
   */
  pricesBySlot?: FlowPricePeriod[];
  /**
   * The source's own periods, written only when they are shorter than an hour
   * (a Homey Energy zone on the 15-minute market). A build that predates
   * sub-hourly prices ignores the field and reads `pricesBySlot`, which is why
   * the finer series could not simply replace it.
   */
  pricesByPeriod?: FlowPricePeriod[];
};

/** A period a source publishes without saying how long it lasts is an hour. */
export const DEFAULT_PERIOD_MINUTES = 60;

type FlowDaySlot = {
  startsAt: string;
  hour: number;
};

type FlowHourValueEntry = {
  hour: number;
  value: number;
};

type ParsedFlowPricePayloadInput = {
  pricesByHour: Record<string, number>;
  pricesBySlot?: FlowPricePeriod[];
};

const DEFAULT_FLOW_HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => hour));

const isValidHour = (hour: number): boolean => Number.isInteger(hour) && hour >= 0 && hour <= 23;

const normalizeNumeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const pushHourValue = (
  target: FlowHourValueEntry[],
  hour: number,
  value: unknown,
): FlowHourValueEntry[] => {
  if (!isValidHour(hour)) return target;
  const numeric = normalizeNumeric(value);
  if (numeric === null) return target;
  return [...target, { hour, value: numeric }];
};

const buildHourValueEntries = (input: unknown): FlowHourValueEntry[] => {
  if (Array.isArray(input)) {
    return input.reduce<FlowHourValueEntry[]>((acc, value, hour) => pushHourValue(acc, hour, value), []);
  }
  if (input && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>).reduce<FlowHourValueEntry[]>(
      (acc, [key, value]) => pushHourValue(acc, Number(key), value),
      [],
    );
  }
  return [];
};

const buildPricesByHourFromEntries = (entries: FlowHourValueEntry[]): Record<string, number> => (
  entries.reduce<Record<string, number>>(
    (acc, entry) => ({ ...acc, [String(entry.hour)]: entry.value }),
    {},
  )
);

const buildPricesByHour = (input: unknown): Record<string, number> => (
  buildPricesByHourFromEntries(buildHourValueEntries(input))
);

/**
 * Local-hour averages of a period series, each hour weighted by how long its
 * periods last. Equal-length periods (four quarters, or one hour) make this the
 * plain mean; the weighting only matters for an hour a source covered
 * unevenly, where a plain mean would let a 15-minute period count as much as a
 * 45-minute one.
 */
export const buildPricesByHourFromPeriods = (
  entries: FlowPricePeriod[],
  timeZone: string,
): Record<string, number> => {
  const buckets = entries.reduce<Record<string, { weighted: number; minutes: number }>>((acc, entry) => {
    const timestamp = Date.parse(entry.startsAt);
    if (!Number.isFinite(timestamp)) return acc;
    const hour = getZonedParts(new Date(timestamp), timeZone).hour;
    const key = String(hour);
    const current = acc[key] ?? { weighted: 0, minutes: 0 };
    return {
      ...acc,
      [key]: {
        weighted: current.weighted + entry.totalPrice * entry.durationMinutes,
        minutes: current.minutes + entry.durationMinutes,
      },
    };
  }, {});

  return Object.entries(buckets).reduce<Record<string, number>>((acc, [hour, bucket]) => {
    if (bucket.minutes <= 0) return acc;
    return {
      ...acc,
      [hour]: bucket.weighted / bucket.minutes,
    };
  }, {});
};

/**
 * A period stored without a duration is an hour: that is what every payload
 * written before periods carried one was. A duration that is present but
 * unusable is not the same fact — it is junk, and the entry goes the way a junk
 * price does, rather than being priced for a span nobody stated.
 */
const resolveStoredPeriodMinutes = (value: unknown): number | null => {
  if (value === undefined || value === null) return DEFAULT_PERIOD_MINUTES;
  const minutes = normalizeNumeric(value);
  if (minutes === null || minutes <= 0 || minutes > 24 * 60) return null;
  return minutes;
};

/**
 * Read boundary for a persisted period array. Drops entries without a usable
 * instant, price or duration, and keeps the first of a repeated start — Homey
 * Energy lists every quarter twice at the 15-minute interval, and a repeat is
 * not a second period.
 */
const normalizeFlowSlotEntries = (input: unknown): FlowPricePeriod[] => {
  if (!Array.isArray(input)) return [];
  const slotMap = input.reduce<Map<string, FlowPricePeriod>>((acc, entry) => {
    if (!entry || typeof entry !== 'object') return acc;
    const record = entry as Record<string, unknown>;
    const startsAtRaw = record.startsAt;
    if (typeof startsAtRaw !== 'string' || !startsAtRaw.trim()) return acc;
    const startsAtMs = Date.parse(startsAtRaw);
    if (!Number.isFinite(startsAtMs)) return acc;
    const totalPrice = normalizeNumeric(record.totalPrice ?? record.total);
    if (totalPrice === null) return acc;
    const durationMinutes = resolveStoredPeriodMinutes(record.durationMinutes);
    if (durationMinutes === null) return acc;
    const startsAt = new Date(startsAtMs).toISOString();
    if (acc.has(startsAt)) return acc;
    acc.set(startsAt, { startsAt, totalPrice, durationMinutes });
    return acc;
  }, new Map<string, FlowPricePeriod>());

  return Array.from(slotMap.values())
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
};

const parseFlowPriceRaw = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Price data is empty.');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const normalized = trimmed.replace(/'/g, '"').replace(/,\s*}/g, '}');
    return JSON.parse(normalized);
  }
};

export const buildFlowDaySlots = (dateKey: string, timeZone: string): FlowDaySlot[] => {
  const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartUtcMs = getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone);
  const { bucketStartUtcMs } = buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone });
  return bucketStartUtcMs.map((bucketStart) => ({
    startsAt: new Date(bucketStart).toISOString(),
    hour: getZonedParts(new Date(bucketStart), timeZone).hour,
  }));
};

export const getExpectedFlowHours = (dateKey: string, timeZone: string): number[] => {
  const seen = new Set<number>();
  return buildFlowDaySlots(dateKey, timeZone).reduce<number[]>((hours, slot) => {
    if (seen.has(slot.hour)) return hours;
    seen.add(slot.hour);
    return [...hours, slot.hour];
  }, []);
};

export const parseFlowPricePayloadInput = (
  raw: unknown,
  context: { dateKey: string; timeZone: string },
): ParsedFlowPricePayloadInput => {
  const parsed = parseFlowPriceRaw(raw);
  const daySlots = buildFlowDaySlots(context.dateKey, context.timeZone);

  if (Array.isArray(parsed) && parsed.length === daySlots.length) {
    const pricesBySlot = daySlots.flatMap((slot, index) => {
      const totalPrice = normalizeNumeric(parsed[index]);
      if (totalPrice === null) return [];
      return [{ startsAt: slot.startsAt, totalPrice, durationMinutes: DEFAULT_PERIOD_MINUTES }];
    });
    const slotPricesByHour = buildPricesByHourFromPeriods(pricesBySlot, context.timeZone);
    const pricesByHour = slotPricesByHour;
    if (pricesBySlot.length === 0 && Object.keys(pricesByHour).length === 0) {
      throw new Error('No valid hourly prices found in price data.');
    }
    return {
      pricesByHour,
      pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
    };
  }

  const basePricesByHour = buildPricesByHour(parsed);

  const exactSlotPrices = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
      const totalPrice = normalizeNumeric(value);
      if (totalPrice === null) return [];
      const matchingSlot = daySlots.find((slot) => slot.startsAt === key);
      if (!matchingSlot) return [];
      return [{ startsAt: matchingSlot.startsAt, totalPrice, durationMinutes: DEFAULT_PERIOD_MINUTES }];
    })
    : [];

  if (exactSlotPrices.length === 0 && Object.keys(basePricesByHour).length === 0) {
    throw new Error('No valid hourly prices found in price data.');
  }

  const slotPricesByHour = buildPricesByHourFromPeriods(exactSlotPrices, context.timeZone);
  return {
    pricesByHour: {
      ...basePricesByHour,
      ...slotPricesByHour,
    },
    pricesBySlot: exactSlotPrices.length > 0 ? exactSlotPrices : undefined,
  };
};

export const getFlowPricePayload = (raw: unknown): FlowPricePayload | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as {
    dateKey?: unknown;
    pricesByHour?: unknown;
    pricesBySlot?: unknown;
    pricesByPeriod?: unknown;
    updatedAt?: unknown;
  };
  if (typeof record.dateKey !== 'string' || !record.dateKey) return null;
  const pricesByHour = buildPricesByHour(record.pricesByHour);
  const pricesBySlot = normalizeFlowSlotEntries(record.pricesBySlot);
  const pricesByPeriod = normalizeFlowSlotEntries(record.pricesByPeriod);
  if (Object.keys(pricesByHour).length === 0 && pricesBySlot.length === 0 && pricesByPeriod.length === 0) {
    return null;
  }
  return {
    dateKey: record.dateKey,
    pricesByHour,
    pricesBySlot: pricesBySlot.length > 0 ? pricesBySlot : undefined,
    pricesByPeriod: pricesByPeriod.length > 0 ? pricesByPeriod : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
};

export const getMissingFlowHours = (
  pricesByHour: Record<string, number>,
  expectedHours: readonly number[] = DEFAULT_FLOW_HOURS,
): number[] => (
  [...expectedHours]
    .filter((hour) => !Number.isFinite(pricesByHour[String(hour)]))
);

/**
 * The payload's priced periods for its own local day, in order.
 *
 * Exact-instant periods are carried through at the length the source published
 * them (a quarter-hour source yields four periods per hour), and an hour no
 * period covers falls back to that hour's value in `pricesByHour` as a single
 * hour-long period. Periods outside the payload's local day are dropped: the
 * payload names one day, and its neighbour owns the rest.
 */
export const buildFlowEntries = (payload: FlowPricePayload, timeZone: string): FlowPricePeriod[] => {
  const daySlots = buildFlowDaySlots(payload.dateKey, timeZone);
  const dayStartMs = getDateKeyStartMs(payload.dateKey, timeZone);
  const dayEndMs = getNextLocalDayStartUtcMs(dayStartMs, timeZone);

  // The payload is already resolved — `getFlowPricePayload` is the seam that
  // validated it — so the periods are read as they stand, not re-normalized.
  // The source's own periods win when it published sub-hourly ones; otherwise
  // the hourly series is the finest thing there is.
  const periods = (payload.pricesByPeriod ?? payload.pricesBySlot ?? []).filter((entry) => {
    const startMs = Date.parse(entry.startsAt);
    return startMs >= dayStartMs && startMs < dayEndMs;
  });
  // Keyed on the hour's start instant, not its clock hour: a DST day repeats a
  // clock hour, and a period covering the first one leaves the second uncovered.
  const slotStartsDescMs = daySlots.map((slot) => Date.parse(slot.startsAt)).reverse();
  const coveredSlotStarts = new Set(periods.flatMap((entry) => {
    const startMs = Date.parse(entry.startsAt);
    const containing = slotStartsDescMs.find((slotStart) => slotStart <= startMs);
    return containing === undefined ? [] : [containing];
  }));

  const hourlyFallback = daySlots.flatMap((slot) => {
    if (coveredSlotStarts.has(Date.parse(slot.startsAt))) return [];
    const price = payload.pricesByHour[String(slot.hour)];
    // An hour the payload never carried a price for is simply not an entry.
    if (price === undefined || !Number.isFinite(price)) return [];
    return [{
      startsAt: slot.startsAt,
      totalPrice: price,
      durationMinutes: DEFAULT_PERIOD_MINUTES,
    }];
  });

  return [...periods, ...hourlyFallback]
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
};
