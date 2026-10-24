import type {
  PriceTimelineLines, PriceTimelinePeriod, PriceTimelineRead,
} from '../../../contracts/src/priceTimeline.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const isPeriod = (value: unknown): value is PriceTimelinePeriod => {
  const period = asRecord(value);
  return period !== null
    && typeof period.startsAt === 'string' && Number.isFinite(Date.parse(period.startsAt))
    && isFiniteNumber(period.durationMinutes) && period.durationMinutes > 0
    && isFiniteNumber(period.importPrice)
    && (period.exportPrice === undefined || isFiniteNumber(period.exportPrice))
    && (period.level === 'cheap' || period.level === 'normal' || period.level === 'expensive');
};

const isLines = (value: unknown): value is PriceTimelineLines => {
  const lines = asRecord(value);
  return lines !== null && isFiniteNumber(lines.average)
    && isFiniteNumber(lines.cheapAtOrBelow) && isFiniteNumber(lines.expensiveFrom);
};

/** Resolve the native-period read once at the Homey API bridge. */
export const classifyPriceTimelineRead = (value: unknown): PriceTimelineRead => {
  const read = asRecord(value);
  if (read?.state === 'unavailable' && (read.reason === 'no_prices' || read.reason === 'read_failed')) {
    return { state: 'unavailable', reason: read.reason };
  }
  const lines = read?.lines;
  if (
    read?.state !== 'ready' || !Array.isArray(read.periods) || !read.periods.every(isPeriod)
    || typeof read.priceUnit !== 'string' || typeof read.hasExportPrice !== 'boolean' || !isLines(lines)
  ) return { state: 'unavailable', reason: 'read_failed' };
  return {
    state: 'ready',
    periods: read.periods,
    priceUnit: read.priceUnit,
    hasExportPrice: read.hasExportPrice,
    lines,
  };
};
