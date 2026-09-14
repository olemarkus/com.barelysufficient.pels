import { buildLocalDayBuckets as buildRuntimeDayBuckets } from '../../lib/utils/dateUtils';
import { buildLocalDayBuckets as buildSharedDayBuckets } from '../../packages/shared-domain/src/utils/dateUtils';

const loadDateUtils = () => require('../../lib/utils/dateUtils.ts') as typeof import('../../lib/utils/dateUtils');

describe('dateUtils time zone handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('computes offsets using the primary formatter path', () => {
    const { getTimeZoneOffsetMinutes } = loadDateUtils();
    const offset = getTimeZoneOffsetMinutes(new Date('2024-01-01T00:00:00.000Z'), 'UTC');
    expect(offset).toBe(0);
  });

  it('falls back to zero on invalid time zones and warns once', () => {
    const { getTimeZoneOffsetMinutes } = loadDateUtils();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const date = new Date('2024-01-01T00:00:00.000Z');

    expect(getTimeZoneOffsetMinutes(date, 'Invalid/Zone')).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getTimeZoneOffsetMinutes(date, 'Invalid/Zone')).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('formats date keys in the requested zone', () => {
    const { getDateKeyInTimeZone } = loadDateUtils();
    const key = getDateKeyInTimeZone(new Date('2024-01-01T23:00:00.000Z'), 'UTC');
    expect(key).toBe('2024-01-01');
  });

  it('resolves repeated fall-back hours to the active occurrence', () => {
    const { getHourStartInTimeZone } = loadDateUtils();
    const timeZone = 'Europe/Oslo';

    const firstOccurrence = getHourStartInTimeZone(new Date('2024-10-27T00:30:00.000Z'), timeZone);
    const secondOccurrence = getHourStartInTimeZone(new Date('2024-10-27T01:30:00.000Z'), timeZone);

    expect(new Date(firstOccurrence).toISOString()).toBe('2024-10-27T00:00:00.000Z');
    expect(new Date(secondOccurrence).toISOString()).toBe('2024-10-27T01:00:00.000Z');
  });

  it('uses calendar day arithmetic across spring-forward boundaries', () => {
    const {
      getDateKeyStartMs,
      getNextLocalDayStartUtcMs,
      getPreviousLocalDayStartUtcMs,
      shiftDateKey,
    } = loadDateUtils();
    const timeZone = 'Europe/Oslo';
    const dateKey = '2024-03-31';
    const dayStartUtcMs = getDateKeyStartMs(dateKey, timeZone);

    expect(shiftDateKey(dateKey, -1)).toBe('2024-03-30');
    expect(shiftDateKey(dateKey, 1)).toBe('2024-04-01');
    expect(new Date(dayStartUtcMs).toISOString()).toBe('2024-03-30T23:00:00.000Z');
    expect(new Date(getNextLocalDayStartUtcMs(dayStartUtcMs, timeZone)).toISOString()).toBe('2024-03-31T22:00:00.000Z');
    expect(new Date(getPreviousLocalDayStartUtcMs(dayStartUtcMs, timeZone)).toISOString()).toBe('2024-03-29T23:00:00.000Z');
  });
});

describe.each([
  ['runtime', buildRuntimeDayBuckets],
  ['shared-domain', buildSharedDayBuckets],
] as const)('%s local day bucket labels', (_name, buildLocalDayBuckets) => {
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
