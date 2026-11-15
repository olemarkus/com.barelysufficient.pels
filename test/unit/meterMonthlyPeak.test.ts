import { homeWizardAdapter } from '../../lib/device/homewizard';
import { plainDeviceAdapter } from '../../lib/device/standardDeviceAdapter';
import { METER_MONTHLY_PEAK_READ_INTERVAL_MS, MeterMonthlyPeaks } from '../../lib/power/meterMonthlyPeak';
import type { MeterMonthlyPeakRead } from '../../lib/ports/homeMeterReadings';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const PEAK = 'measure_power.montly_power_peak';
const STAMP = '2026-09-03T18:15:00.000Z';

// A HomeWizard P1 meter (`energy_v2`) with the meter's own month peak, in W.
const p1 = (entry: Record<string, unknown> | undefined, declared = true): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS,
  id: 'p1', name: 'P1 meter', class: 'sensor', driverId: 'homey:app:com.homewizard:energy_v2',
  ownerUri: 'homey:app:com.homewizard',
  capabilities: declared ? ['measure_power', PEAK] : ['measure_power'],
  capabilitiesObj: {
    measure_power: { value: 900, lastUpdated: STAMP },
    ...(entry === undefined ? {} : { [PEAK]: entry }),
  },
});

describe('HomeWizard P1 month peak', () => {
  it('reads the meter\'s peak in kW, dated by Homey', () => {
    expect(homeWizardAdapter.meterMonthlyPeak(p1({ value: 6_450, lastUpdated: STAMP })))
      .toEqual({ state: 'read', peakKw: 6.45, observedAtMs: Date.parse(STAMP) });
    expect(homeWizardAdapter.meterMonthlyPeak(p1({ value: 0, lastUpdated: STAMP })))
      .toEqual({ state: 'read', peakKw: 0, observedAtMs: Date.parse(STAMP) });
  });

  it.each([
    ['no value yet', { value: null, lastUpdated: STAMP }],
    ['a string', { value: '6450', lastUpdated: STAMP }],
    ['a negative value', { value: -10, lastUpdated: STAMP }],
    ['a non-finite value', { value: Number.POSITIVE_INFINITY, lastUpdated: STAMP }],
    ['no stamp', { value: 6_450 }],
    ['an unreadable stamp', { value: 6_450, lastUpdated: 'soon' }],
    ['no entry', undefined],
  ])('is unavailable, never zero, with %s', (_label, entry) => {
    expect(homeWizardAdapter.meterMonthlyPeak(p1(entry))).toEqual({ state: 'unavailable' });
  });

  it('reports none for a P1 without the capability, and for a device of another app', () => {
    expect(homeWizardAdapter.meterMonthlyPeak(p1(undefined, false))).toEqual({ state: 'none' });
    expect(plainDeviceAdapter.meterMonthlyPeak({ ...p1({ value: 6_450, lastUpdated: STAMP }),
      driverId: 'homey:app:com.test:meter', ownerUri: 'homey:app:com.test' })).toEqual({ state: 'none' });
  });
});

describe('MeterMonthlyPeaks', () => {
  const nowMs = Date.parse('2026-09-17T10:00:00.000Z');
  const read = (peakKw: number): MeterMonthlyPeakRead => ({ state: 'read', peakKw, observedAtMs: Date.parse(STAMP) });

  it('keeps the last accepted peak through a failed or malformed read', () => {
    const peaks = new MeterMonthlyPeaks();
    peaks.admit('p1', read(6.45));
    peaks.admit('p1', { state: 'unavailable' });
    expect(peaks.current('p1')).toEqual({ peakKw: 6.45, observedAtMs: Date.parse(STAMP) });
  });

  it('has none for a meter that reports none, or no meter', () => {
    const peaks = new MeterMonthlyPeaks();
    peaks.admit('p1', read(6.45));
    peaks.admit('p1', { state: 'none' });
    expect(peaks.current('p1')).toBeNull();
    expect(peaks.current(null)).toBeNull();
  });

  it('reads the meters at most once a minute and forgets a meter no longer read', async () => {
    const peaks = new MeterMonthlyPeaks();
    const reader = vi.fn(async (meterDeviceId: string) => read(meterDeviceId === 'a' ? 3 : 4));
    await peaks.refresh(['a', 'b'], 'a', reader, nowMs);
    await peaks.refresh(['a', 'b'], 'a', reader, nowMs + METER_MONTHLY_PEAK_READ_INTERVAL_MS - 1);
    expect(reader).toHaveBeenCalledTimes(2);

    await peaks.refresh(['a'], 'a', reader, nowMs + METER_MONTHLY_PEAK_READ_INTERVAL_MS);
    expect(reader).toHaveBeenCalledTimes(3);
    expect(peaks.current('a')?.peakKw).toBe(3);
    expect(peaks.current('b')).toBeNull();
  });

  it('keeps one read under way at a time, however long a meter device takes', async () => {
    const peaks = new MeterMonthlyPeaks();
    let answer: (value: MeterMonthlyPeakRead) => void = () => undefined;
    const reader = vi.fn(() => new Promise<MeterMonthlyPeakRead>((resolve) => { answer = resolve; }));
    const first = peaks.refresh(['a'], 'a', reader, nowMs);
    // A minute later the read has not come back: the next poll does not start another.
    const second = peaks.refresh(['a'], 'a', reader, nowMs + METER_MONTHLY_PEAK_READ_INTERVAL_MS);
    expect(reader).toHaveBeenCalledOnce();

    answer(read(5));
    await Promise.all([first, second]);
    expect(peaks.current('a')?.peakKw).toBe(5);
    // Once it has, the next minute's poll reads again.
    void peaks.refresh(['a'], 'a', reader, nowMs + 2 * METER_MONTHLY_PEAK_READ_INTERVAL_MS);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("answers Main's peak for the meter the poll names Main's, even between reads", async () => {
    const peaks = new MeterMonthlyPeaks();
    const reader = vi.fn(async (meterDeviceId: string) => read(meterDeviceId === 'main' ? 6 : 2));
    await peaks.refresh(['main', 'area'], 'main', reader, nowMs);
    expect(peaks.currentMain()?.peakKw).toBe(6);

    await peaks.refresh(['main', 'area'], 'area', reader, nowMs + 1);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(peaks.currentMain()?.peakKw).toBe(2);

    await peaks.refresh(['area'], null, reader, nowMs + 2);
    expect(peaks.currentMain()).toBeNull();
  });
});
