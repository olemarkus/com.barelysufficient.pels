import {
  formatPowerUsageEmptyAwaitingSamples,
  formatPowerUsageEmptyForWeek,
  formatPowerUsageHourlyTotal,
} from '../../packages/shared-domain/src/powerUsageStrings';

describe('powerUsageStrings', () => {
  it('returns the selected-week empty copy without internal vocabulary', () => {
    const text = formatPowerUsageEmptyForWeek();
    expect(text).toBe('No hourly usage for the selected week.');
    expect(text).not.toMatch(/bucket|sample/i);
  });

  it('points awaiting-samples users at the Report power usage Flow action', () => {
    const text = formatPowerUsageEmptyAwaitingSamples();
    expect(text).toBe('Set up the Report power usage Flow action to start recording.');
    expect(text.toLowerCase()).toContain('report power usage');
    // The reworded copy should not expose internal vocabulary ("bucket",
    // "sample") or the leftover "Wire" verb the previous draft used.
    expect(text).not.toMatch(/bucket|sample|wire/i);
  });

  it('formats single-bucket hourly totals without the "total" qualifier', () => {
    expect(formatPowerUsageHourlyTotal(1.234, { aggregated: false })).toBe('1.23 kWh');
    expect(formatPowerUsageHourlyTotal(0, { aggregated: false })).toBe('0.00 kWh');
  });

  it('marks aggregated hourly totals with a "total" suffix', () => {
    expect(formatPowerUsageHourlyTotal(1.5, { aggregated: true })).toBe('1.50 kWh total');
    expect(formatPowerUsageHourlyTotal(2.345, { aggregated: true })).toBe('2.35 kWh total');
  });

  it('renders non-finite kWh values as 0.00 so tooltips and log lines stay readable', () => {
    expect(formatPowerUsageHourlyTotal(Number.NaN, { aggregated: false })).toBe('0.00 kWh');
    expect(formatPowerUsageHourlyTotal(Number.POSITIVE_INFINITY, { aggregated: false })).toBe('0.00 kWh');
    expect(formatPowerUsageHourlyTotal(Number.NEGATIVE_INFINITY, { aggregated: false })).toBe('0.00 kWh');
    expect(formatPowerUsageHourlyTotal(Number.NaN, { aggregated: true })).toBe('0.00 kWh total');
    expect(formatPowerUsageHourlyTotal(Number.POSITIVE_INFINITY, { aggregated: true })).toBe('0.00 kWh total');
    expect(formatPowerUsageHourlyTotal(Number.NEGATIVE_INFINITY, { aggregated: true })).toBe('0.00 kWh total');
  });
});
