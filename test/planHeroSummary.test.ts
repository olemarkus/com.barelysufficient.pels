import {
  formatFreshnessChip,
  formatHeroHeadline,
  type PlanHeroMetaInput,
} from '../packages/shared-domain/src/planHeroSummary';

const NOW = Date.UTC(2026, 3, 20, 12, 0, 0);

const meta = (overrides: Partial<PlanHeroMetaInput> = {}): PlanHeroMetaInput => ({
  totalKw: 5.2,
  softLimitKw: 11.0,
  headroomKw: 5.8,
  hardCapLimitKw: 14,
  hardCapHeadroomKw: 3,
  controlledKw: 3.1,
  uncontrolledKw: 2.1,
  lastPowerUpdateMs: NOW - 120_000,
  ...overrides,
});

describe('formatHeroHeadline', () => {
  it('returns null when required fields are missing', () => {
    expect(formatHeroHeadline(undefined, NOW)).toBeNull();
    expect(formatHeroHeadline({ totalKw: 5 }, NOW)).toBeNull();
  });

  it('formats an under-budget state with kW to spare', () => {
    const headline = formatHeroHeadline(meta(), NOW);
    expect(headline).not.toBeNull();
    if (!headline) return;
    expect(headline.kwText).toBe('5.2 kW');
    expect(headline.limitText).toBe('of 11.0 kW limit');
    expect(headline.message).toBe('5.8 kW to spare');
    expect(headline.tone).toBe('ok');
    expect(headline.overSoftLimit).toBe(false);
    expect(headline.overHardLimit).toBe(false);
    expect(headline.hardLimitKw).toBeCloseTo(14);
    expect(headline.ageText).toBe('2m ago');
  });

  it('flags over-soft-limit state', () => {
    const headline = formatHeroHeadline(meta({
      totalKw: 12,
      headroomKw: -1,
      hardCapHeadroomKw: 2,
    }), NOW);
    expect(headline?.tone).toBe('warn');
    expect(headline?.message).toBe('Over the power limit');
    expect(headline?.overSoftLimit).toBe(true);
    expect(headline?.overHardLimit).toBe(false);
  });

  it('flags over-hard-limit state', () => {
    const headline = formatHeroHeadline(meta({
      totalKw: 15,
      headroomKw: -4,
      hardCapLimitKw: 14,
      hardCapHeadroomKw: -1,
    }), NOW);
    expect(headline?.tone).toBe('alert');
    expect(headline?.message).toBe('Over the hard limit');
    expect(headline?.overHardLimit).toBe(true);
    expect(headline?.hardLimitKw).toBe(14);
  });

  it('surfaces a shortfall message when capacity is being throttled', () => {
    const headline = formatHeroHeadline(meta({
      capacityShortfall: true,
      totalKw: 9,
      headroomKw: 2,
    }), NOW);
    expect(headline?.message).toBe('Keeping power under the limit');
  });

  it('omits age text when lastPowerUpdateMs is missing', () => {
    const headline = formatHeroHeadline(meta({ lastPowerUpdateMs: undefined }), NOW);
    expect(headline?.ageText).toBeNull();
  });

  it('leaves hardLimitKw null when no hard cap headroom is available', () => {
    const headline = formatHeroHeadline(meta({ hardCapLimitKw: null, hardCapHeadroomKw: null }), NOW);
    expect(headline?.hardLimitKw).toBeNull();
    expect(headline?.overHardLimit).toBe(false);
  });
});

describe('formatFreshnessChip', () => {
  it('returns null when no state is provided', () => {
    expect(formatFreshnessChip(undefined)).toBeNull();
  });

  it('maps each freshness state to a plain-English label', () => {
    expect(formatFreshnessChip('fresh')).toEqual({ kind: 'fresh', label: 'Live', tone: 'ok' });
    expect(formatFreshnessChip('stale_hold')).toEqual({ kind: 'stale_hold', label: 'Delayed', tone: 'warn' });
    expect(formatFreshnessChip('stale_fail_closed')).toEqual({
      kind: 'stale_fail_closed',
      label: 'No data',
      tone: 'alert',
    });
  });
});
