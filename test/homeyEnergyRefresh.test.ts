import { getDateKeyInTimeZone } from '../lib/utils/dateUtils';
import { buildHomeyEnergyDateInfo } from '../lib/price/homeyEnergyRefresh';

describe('homeyEnergyRefresh date selection', () => {
  it('uses local calendar day arithmetic across spring-forward eve', () => {
    const timeZone = 'Europe/Oslo';
    const now = new Date('2024-03-30T22:30:00.000Z');

    const info = buildHomeyEnergyDateInfo(timeZone, now);

    expect(info.todayKey).toBe('2024-03-30');
    expect(info.tomorrowKey).toBe('2024-03-31');
    expect(getDateKeyInTimeZone(info.today, timeZone)).toBe('2024-03-30');
    expect(getDateKeyInTimeZone(info.tomorrow, timeZone)).toBe('2024-03-31');
  });
});
