import { buildLocalDayBuckets } from '../../packages/shared-domain/src/utils/dateUtils';
import { getHourStartInTimeZone } from '../../lib/utils/hourBuckets';

const loadDateUtils = () => import('../../packages/shared-domain/src/utils/dateUtils.js');

describe('dateUtils time zone handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('computes offsets using the primary formatter path', async () => {
    const { getTimeZoneOffsetMinutes } = await loadDateUtils();
    const offset = getTimeZoneOffsetMinutes(new Date('2024-01-01T00:00:00.000Z'), 'UTC');
    expect(offset).toBe(0);
  });

  it('falls back to zero on invalid time zones and warns once', async () => {
    const { getTimeZoneOffsetMinutes } = await loadDateUtils();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const date = new Date('2024-01-01T00:00:00.000Z');

    expect(getTimeZoneOffsetMinutes(date, 'Invalid/Zone')).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getTimeZoneOffsetMinutes(date, 'Invalid/Zone')).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('formats date keys in the requested zone', async () => {
    const { getDateKeyInTimeZone } = await loadDateUtils();
    const key = getDateKeyInTimeZone(new Date('2024-01-01T23:00:00.000Z'), 'UTC');
    expect(key).toBe('2024-01-01');
  });

  it('resolves repeated fall-back hours to the active occurrence', () => {
    const timeZone = 'Europe/Oslo';

    const firstOccurrence = getHourStartInTimeZone(new Date('2024-10-27T00:30:00.000Z'), timeZone);
    const secondOccurrence = getHourStartInTimeZone(new Date('2024-10-27T01:30:00.000Z'), timeZone);

    expect(new Date(firstOccurrence).toISOString()).toBe('2024-10-27T00:00:00.000Z');
    expect(new Date(secondOccurrence).toISOString()).toBe('2024-10-27T01:00:00.000Z');
  });

  it('uses calendar day arithmetic across spring-forward boundaries', async () => {
    const {
      getDateKeyStartMs,
      getNextLocalDayStartUtcMs,
      getPreviousLocalDayStartUtcMs,
      shiftDateKey,
    } = await loadDateUtils();
    const timeZone = 'Europe/Oslo';
    const dateKey = '2024-03-31';
    const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);

    expect(shiftDateKey(dateKey, -1)).toBe('2024-03-30');
    expect(shiftDateKey(dateKey, 1)).toBe('2024-04-01');
    expect(new Date(dayStartUtcMs).toISOString()).toBe('2024-03-30T23:00:00.000Z');
    expect(new Date(getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone)).toISOString()).toBe('2024-03-31T22:00:00.000Z');
    expect(new Date(getPreviousLocalDayStartUtcMs(dayStartUtcMs, timeZone)).toISOString()).toBe('2024-03-29T23:00:00.000Z');
  });

  it('reuses day boundaries, including the zero timestamp, without formatting again', async () => {
    const { getDateKeyStartMs } = await loadDateUtils();
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      expect(getDateKeyStartMs('1970-01-01', 'UTC')).toBe(0);
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      expect(getDateKeyStartMs('1970-01-01', 'UTC')).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps cached boundaries separate across zones, dates and DST changes', async () => {
    const { getDateKeyStartMs } = await loadDateUtils();
    const cases = [
      ['2024-03-31', 'Europe/Oslo', '2024-03-30T23:00:00.000Z'],
      ['2024-04-01', 'Europe/Oslo', '2024-03-31T22:00:00.000Z'],
      ['2024-10-27', 'Europe/Oslo', '2024-10-26T22:00:00.000Z'],
      ['2024-10-28', 'Europe/Oslo', '2024-10-27T23:00:00.000Z'],
      ['2024-03-31', 'Asia/Kolkata', '2024-03-30T18:30:00.000Z'],
      ['2024-03-31', 'UTC', '2024-03-31T00:00:00.000Z'],
      // Apia skipped this local date; preserve the search's next-day boundary.
      ['2011-12-30', 'Pacific/Apia', '2011-12-30T10:00:00.000Z'],
    ] as const;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const [dateKey, zone, expected] of cases) {
        expect(new Date(getDateKeyStartMs(dateKey, zone)).toISOString()).toBe(expected);
      }
    }
  });

  it('evicts older day boundaries instead of retaining unlimited history', async () => {
    const { getDateKeyStartMs, shiftDateKey } = await loadDateUtils();
    const firstDate = '2020-01-01';
    const firstBoundary = getDateKeyStartMs(firstDate, 'UTC');
    for (let day = 1; day < 600; day += 1) {
      getDateKeyStartMs(shiftDateKey(firstDate, day), 'UTC');
    }
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      getDateKeyStartMs(shiftDateKey(firstDate, 599), 'UTC');
      expect(spy).not.toHaveBeenCalled();
      expect(getDateKeyStartMs(firstDate, 'UTC')).toBe(firstBoundary);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('does not cache failed boundary lookups', async () => {
    const { getDateKeyStartMs } = await loadDateUtils();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => getDateKeyStartMs('2024-01-01', 'Invalid/Zone')).toThrow(RangeError);
    }
  });
});

describe('local day bucket labels', () => {
  it('keeps timezone labels independent across repeated calls', () => {
    const dayStartUtcMs = Date.parse('2024-01-01T00:00:00.000Z');
    const nextDayStartUtcMs = dayStartUtcMs + 2 * 60 * 60 * 1000;

    for (const timeZone of ['Europe/Oslo', 'Asia/Kolkata', 'Europe/Oslo']) {
      const { bucketStartLocalLabels } = buildLocalDayBuckets({ dayStartUtcMs, nextDayStartUtcMs, timeZone });
      expect(bucketStartLocalLabels).toEqual(timeZone === 'Europe/Oslo' ? ['01:00', '02:00'] : ['05:30', '06:30']);
    }
  });

  it('keeps the same timezone formatter correct across spring and fall DST transitions', () => {
    const timeZone = 'Europe/Oslo';
    const spring = buildLocalDayBuckets({
      dayStartUtcMs: Date.parse('2024-03-30T23:00:00.000Z'),
      nextDayStartUtcMs: Date.parse('2024-03-31T22:00:00.000Z'),
      timeZone,
    });
    expect(spring.bucketStartLocalLabels).toHaveLength(23);
    expect(spring.bucketStartLocalLabels.slice(0, 4)).toEqual(['00:00', '01:00', '03:00', '04:00']);
    expect(spring.bucketStartLocalLabels.at(-1)).toBe('23:00');

    const fall = buildLocalDayBuckets({
      dayStartUtcMs: Date.parse('2024-10-26T22:00:00.000Z'),
      nextDayStartUtcMs: Date.parse('2024-10-27T23:00:00.000Z'),
      timeZone,
    });
    expect(fall.bucketStartLocalLabels).toHaveLength(25);
    expect(fall.bucketStartLocalLabels.slice(0, 5)).toEqual(['00:00', '01:00', '02:00', '02:00', '03:00']);
    expect(fall.bucketStartLocalLabels.at(-1)).toBe('23:00');
    expect(fall.bucketStartUtcMs.slice(2, 4)).toEqual([
      Date.parse('2024-10-27T00:00:00.000Z'),
      Date.parse('2024-10-27T01:00:00.000Z'),
    ]);
  });
});
