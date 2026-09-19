import { describe, expect, it, vi } from 'vitest';

const homeyMocks = vi.hoisted(() => ({
  getHomeyTimezone: vi.fn(() => 'Europe/Oslo'),
}));
vi.mock('../src/ui/homey.ts', () => homeyMocks);

import { buildHomeyStatus } from '../src/ui/priceConfigStatus.ts';
import type { SettingsUiPricesPayload } from '../../contracts/src/settingsUiApi.ts';

const dateKey = '2026-01-19';
const localMidnightUtcMs = Date.parse('2026-01-18T23:00:00.000Z');

const hourlyPayload = (): Record<string, unknown> => ({
  dateKey,
  pricesByHour: Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour), 1 + hour])),
  updatedAt: '2026-01-18T22:00:00.000Z',
});

const quarterHourPayload = (): Record<string, unknown> => ({
  ...hourlyPayload(),
  pricesBySlot: Array.from({ length: 96 }, (_, index) => ({
    startsAt: new Date(localMidnightUtcMs + index * 15 * 60_000).toISOString(),
    totalPrice: 1 + index / 4,
    durationMinutes: 15,
  })),
});

const buildPayload = (today: Record<string, unknown>): SettingsUiPricesPayload => ({
  homeyToday: today,
  homeyTomorrow: null,
  homeyCurrency: 'NOK',
} as unknown as SettingsUiPricesPayload);

describe('price config status', () => {
  it('counts a full day as 24 hours whether the zone sends hours or quarters', () => {
    vi.setSystemTime(new Date('2026-01-19T10:00:00.000Z'));

    const hourly = buildHomeyStatus(buildPayload(hourlyPayload())).today;
    const quarterly = buildHomeyStatus(buildPayload(quarterHourPayload())).today;

    // A 15-minute zone sends 96 prices for the same complete day: "96/24" would
    // read as a fault, so the owner is told what they care about — hours priced.
    expect(hourly.text).toContain('24/24 hours');
    expect(quarterly.text).toContain('24/24 hours');
    expect(quarterly.tone).toBe('ok');
  });

  it('reports the hours a partial quarter-hour day is missing', () => {
    vi.setSystemTime(new Date('2026-01-19T10:00:00.000Z'));
    const partial = quarterHourPayload();
    // A zone that has published only the first four hours of the day so far.
    const payload = {
      dateKey,
      updatedAt: partial.updatedAt,
      pricesByHour: Object.fromEntries(Array.from({ length: 4 }, (_, hour) => [String(hour), 1 + hour])),
      pricesBySlot: (partial.pricesBySlot as unknown[]).slice(0, 16),
    };

    const status = buildHomeyStatus(buildPayload(payload)).today;

    expect(status.text).toContain('4/24 hours');
    expect(status.text).toContain('(20 missing)');
    expect(status.tone).toBe('warn');
  });
  describe('why prices are paused', () => {
    const withFormula = (homeyPriceFormula: SettingsUiPricesPayload['homeyPriceFormula']) => (
      buildHomeyStatus({ ...buildPayload(hourlyPayload()), homeyPriceFormula })
    );

    it('stays quiet while prices work', () => {
      expect(withFormula({ kind: 'applied' }).priceSetupIssue).toBeNull();
      // A home whose owner entered no costs in Homey is priced by the raw
      // value Homey publishes — working, and nothing to report.
      expect(withFormula({ kind: 'none' }).priceSetupIssue).toBeNull();
    });

    it('names an expression it cannot read', () => {
      const issue = withFormula({ kind: 'unsupported', expression: '{{ sqrt([[price]]) }}' }).priceSetupIssue;
      expect(issue?.value.text).toBe('Not usable');
      expect(issue?.detail).toContain('sqrt');
    });

    it('separates a formula that reads fine but prices nothing', () => {
      // Same blank series for the owner, different cause and different fix:
      // there is nothing wrong with the expression itself.
      const issue = withFormula({ kind: 'prices_nothing', expression: '{{ ([[price]] - 1) ^ 0.5 }}' }).priceSetupIssue;
      expect(issue?.value.text).toBe('No usable prices');
      expect(issue?.detail).toContain('doesn’t produce a usable price');
    });

    it('says so when the setup has not been read yet', () => {
      expect(withFormula({ kind: 'unknown' }).priceSetupIssue?.value.text).toBe('Not read yet');
    });
  });
});
