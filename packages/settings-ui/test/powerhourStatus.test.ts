import { describe, expect, it, vi } from 'vitest';

const homeyMocks = vi.hoisted(() => ({
  getHomeyTimezone: vi.fn(() => 'Europe/Oslo'),
}));
vi.mock('../src/ui/homey.ts', () => homeyMocks);

import { buildPowerhourStatus } from '../src/ui/priceConfigStatus.ts';
import type {
  PowerhourSourceUiStatus,
  SettingsUiPricesPayload,
} from '../../contracts/src/settingsUiApi.ts';

const todayKey = '2026-01-19';
const tomorrowKey = '2026-01-20';

const device = {
  deviceId: 'no2',
  deviceName: 'NO_Norway_2',
  priceIntervalMinutes: 60,
  biddingZone: '10YNO-2--------T',
};

const reading: PowerhourSourceUiStatus = { kind: 'reading', selected: device, devices: [device] };

/** A day payload holding the hours `fromHour`..23. */
const dayFrom = (dateKey: string, fromHour: number): Record<string, unknown> => ({
  dateKey,
  pricesByHour: Object.fromEntries(
    Array.from({ length: 24 - fromHour }, (_, index) => [String(fromHour + index), 1]),
  ),
  updatedAt: '2026-01-19T09:00:00.000Z',
});

const buildPayload = (overrides: Partial<SettingsUiPricesPayload>): SettingsUiPricesPayload => ({
  powerhourSource: reading,
  powerhourCurrency: '€',
  powerhourToday: null,
  powerhourTomorrow: null,
  ...overrides,
} as unknown as SettingsUiPricesPayload);

describe('Power by the Hour status', () => {
  // The app publishes only from the current period onwards, so a home that
  // started reading it at noon was never offered this morning. Counting those
  // hours as missing would report a fault that is not one.
  it('counts today against the hours still on offer, not the whole day', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z')); // 12:00 Oslo

    const status = buildPowerhourStatus(buildPayload({ powerhourToday: dayFrom(todayKey, 12) }));

    // The ratio counts the whole day, because that is what the stored hours are
    // a part of; what the on-offer window changes is the MISSING count, and
    // nothing here is missing.
    expect(status.today.text).toContain('12/24 hours');
    expect(status.today.text).not.toContain('missing');
    expect(status.today.tone).toBe('ok');
  });

  // The merged day keeps hours the app has stopped offering, so a narrower
  // denominator would print "18/9 hours" an hour after the source was adopted.
  it('never reports more stored hours than the day has', () => {
    vi.setSystemTime(new Date('2026-01-19T20:00:00.000Z')); // 21:00 Oslo
    const status = buildPowerhourStatus(buildPayload({ powerhourToday: dayFrom(todayKey, 0) }));

    expect(status.today.text).toContain('24/24 hours');
    expect(status.today.tone).toBe('ok');
  });

  it('still reports an hour the app should have supplied and did not', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));
    const partial = dayFrom(todayKey, 12);
    delete (partial.pricesByHour as Record<string, number>)['15'];

    const status = buildPowerhourStatus(buildPayload({ powerhourToday: partial }));

    expect(status.today.text).toContain('(1 missing)');
    expect(status.today.tone).toBe('warn');
  });

  it('counts tomorrow as a whole day', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));

    const status = buildPowerhourStatus(buildPayload({
      powerhourTomorrow: dayFrom(tomorrowKey, 0),
    }));

    expect(status.tomorrow.text).toContain('24/24 hours');
    expect(status.tomorrow.tone).toBe('ok');
  });

  it('says so when a day has arrived at all', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));

    const status = buildPowerhourStatus(buildPayload({}));

    expect(status.today.text).toBe('No data received');
    expect(status.today.tone).toBe('warn');
  });

  it('carries the app’s currency, and warns when there is none', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));

    expect(buildPowerhourStatus(buildPayload({})).currency).toBe('€');
    const unknown = buildPowerhourStatus(buildPayload({ powerhourCurrency: null }));
    expect(unknown.currency).toBe('Unknown');
    expect(unknown.currencyTone).toBe('warn');
  });

  // A failed read is a no-op: the stored days survive it and the planner keeps
  // using them, so the page has to keep showing them.
  it('reports stored days even while the source is unavailable', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));

    const status = buildPowerhourStatus(buildPayload({
      powerhourSource: { kind: 'app_unavailable' },
      powerhourToday: dayFrom(todayKey, 12),
    }));

    expect(status.hasStoredDays).toBe(true);
    expect(status.today.text).toContain('12/24 hours');
  });

  it('reports no stored days when neither has arrived', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));
    expect(buildPowerhourStatus(buildPayload({})).hasStoredDays).toBe(false);
  });

  it('carries the runtime’s account of the source through untouched', () => {
    vi.setSystemTime(new Date('2026-01-19T11:00:00.000Z'));
    const source: PowerhourSourceUiStatus = { kind: 'not_permitted' };

    expect(buildPowerhourStatus(buildPayload({ powerhourSource: source })).source).toEqual(source);
  });
});
