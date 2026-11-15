import { createHeldCapacityLimitRead, resolveHeldPowerLimits } from '../../lib/power/heldCapacityLimit';
import type { CapacityMonthPeak } from '../../lib/power/capacityPeak';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';

const SCALARS: CapacityScalarSettings = {
  capacityEnabled: true,
  gridImportLimitKw: 11,
  limitKw: 5,
  marginKw: 0.3,
  periodMinutes: 15,
  dryRun: false,
  followMonthPeak: true,
};
const PEAK_ABOVE: CapacityMonthPeak = { state: 'recorded', peakKw: 7.5 };

const configured = (scalars: CapacityScalarSettings) => ({
  capacityEnabled: scalars.capacityEnabled,
  gridImportLimitKw: scalars.gridImportLimitKw,
  limitKw: scalars.limitKw,
  marginKw: scalars.marginKw,
  periodMinutes: scalars.periodMinutes,
  hardCapSource: 'configured',
  configuredLimitKw: scalars.limitKw,
});

describe('resolveHeldPowerLimits', () => {
  it('holds this month\'s peak once it is above the configured hard cap', () => {
    expect(resolveHeldPowerLimits(SCALARS, PEAK_ABOVE)).toEqual({
      capacityEnabled: true,
      gridImportLimitKw: 11,
      limitKw: 7.5,
      marginKw: 0.3,
      periodMinutes: 15,
      hardCapSource: 'month_peak',
      configuredLimitKw: 5,
    });
  });

  it('never moves the grid import limit or the margin', () => {
    const held = resolveHeldPowerLimits(SCALARS, { state: 'recorded', peakKw: 20 });
    expect(held.gridImportLimitKw).toBe(11);
    expect(held.marginKw).toBe(0.3);
  });

  it.each<[string, CapacityScalarSettings, CapacityMonthPeak]>([
    ['the switch is off', { ...SCALARS, followMonthPeak: false }, PEAK_ABOVE],
    ['the period is hourly', { ...SCALARS, periodMinutes: 60 }, PEAK_ABOVE],
    ['Capacity limit is off', { ...SCALARS, capacityEnabled: false }, PEAK_ABOVE],
    ['the month has no completed quarter', SCALARS, { state: 'no_completed_quarter' }],
    ['the peak is below the hard cap', SCALARS, { state: 'recorded', peakKw: 4.2 }],
    ['the peak equals the hard cap', SCALARS, { state: 'recorded', peakKw: 5 }],
  ])('keeps the configured hard cap when %s', (_label, scalars, peak) => {
    expect(resolveHeldPowerLimits(scalars, peak)).toEqual(configured(scalars));
  });
});

describe('createHeldCapacityLimitRead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves against the peak of the month it is read in', () => {
    vi.setSystemTime(Date.parse('2026-09-30T21:50:00.000Z'));
    const read = createHeldCapacityLimitRead({
      readScalars: () => SCALARS,
      readTracker: () => ({ capacityMonthlyPeak: { monthKey: '2026-09', peakKw: 7.5 } }),
      readTimeZone: () => 'Europe/Brussels',
    });

    expect(read().limitKw).toBe(7.5);
    // Local midnight in Brussels: the September peak is no longer this month's.
    vi.setSystemTime(Date.parse('2026-09-30T22:00:00.000Z'));
    expect(read()).toEqual(configured(SCALARS));
  });
});
