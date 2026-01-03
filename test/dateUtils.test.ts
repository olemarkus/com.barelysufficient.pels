const loadDateUtils = () => require('../lib/utils/dateUtils') as typeof import('../lib/utils/dateUtils');

describe('dateUtils time zone handling', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('computes offsets using the primary formatter path', () => {
    const { getTimeZoneOffsetMinutes } = loadDateUtils();
    const offset = getTimeZoneOffsetMinutes(new Date('2024-01-01T00:00:00.000Z'), 'UTC');
    expect(offset).toBe(0);
  });

  it('falls back to zero on invalid time zones and warns once', () => {
    const { getTimeZoneOffsetMinutes } = loadDateUtils();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
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
});
