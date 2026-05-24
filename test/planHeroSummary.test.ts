import {
  buildDecisionSentence,
  computeEnergyBarScaleKWh,
  formatAboveHardCapSubline,
  formatAboveSafePaceSubline,
  formatCheapestUpcomingHour,
  formatEnergyMeterMarkerLabels,
  formatEnergyUsedOfBudget,
  formatFreshnessChip,
  formatHeroHeadline,
  formatPowerMeterMarkerLabels,
  formatProjectedEnergySubline,
  type DecisionSentenceInput,
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
    expect(headline?.message).toBe('Above safe pace');
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
    expect(headline?.message).toBe('Above hard cap');
    expect(headline?.overHardLimit).toBe(true);
    expect(headline?.hardLimitKw).toBe(14);
  });

  it('surfaces a shortfall message when capacity is being throttled', () => {
    const headline = formatHeroHeadline(meta({
      capacityShortfall: true,
      totalKw: 9,
      headroomKw: 2,
    }), NOW);
    expect(headline?.message).toBe('Keeping power under the hard cap');
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

describe('formatEnergyUsedOfBudget', () => {
  it('formats both sides with one-decimal precision', () => {
    expect(formatEnergyUsedOfBudget(4.2, 11)).toBe('4.2 of 11.0 kWh used');
    expect(formatEnergyUsedOfBudget(0, 4.5)).toBe('0.0 of 4.5 kWh used');
    expect(formatEnergyUsedOfBudget(1.25, 0.9)).toBe('1.3 of 0.9 kWh used');
  });
});

describe('formatProjectedEnergySubline', () => {
  it('returns null when no projection is available', () => {
    expect(formatProjectedEnergySubline(null)).toBeNull();
  });

  it('renders "projected X.XX kWh" with two-decimal precision', () => {
    expect(formatProjectedEnergySubline(2.347)).toBe('projected 2.35 kWh');
    expect(formatProjectedEnergySubline(5)).toBe('projected 5.00 kWh');
    expect(formatProjectedEnergySubline(0)).toBe('projected 0.00 kWh');
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

describe('hero meter marker labels', () => {
  it('formats power markers with short legend + screen-reader labels', () => {
    expect(formatPowerMeterMarkerLabels('target', 11)).toEqual({
      short: 'Safe pace',
      aria: 'Safe pace now 11.0 kW',
    });
    expect(formatPowerMeterMarkerLabels('cap', 14)).toEqual({
      short: 'Hard cap',
      aria: 'Hard cap 14.0 kW',
    });
  });

  it('formats energy markers with short legend + screen-reader labels', () => {
    expect(formatEnergyMeterMarkerLabels('target', 5)).toEqual({
      short: 'Budget this hour',
      aria: 'Budget this hour 5.0 kWh',
    });
    expect(formatEnergyMeterMarkerLabels('projected', 4.4)).toEqual({
      short: 'Projected this hour',
      aria: 'Projected this hour 4.4 kWh',
    });
  });
});

describe('buildDecisionSentence', () => {
  const baseline = (overrides: Partial<DecisionSentenceInput> = {}): DecisionSentenceInput => ({
    limitedCount: 0,
    resumingCount: 0,
    freshness: 'fresh',
    dryRun: false,
    overHardLimit: false,
    projectedOverBudget: false,
    safePaceKw: 12,
    ...overrides,
  });

  it('returns the quiet-hour copy when nothing is happening', () => {
    expect(buildDecisionSentence(baseline())).toEqual({
      text: 'Quiet hour. Nothing to do.',
      positive: true,
    });
  });

  it('routes stale_fail_closed to the no-data line first', () => {
    expect(buildDecisionSentence(baseline({
      freshness: 'stale_fail_closed',
      limitedCount: 3,
      overHardLimit: true,
    })).text).toBe('Power readings have dropped. Devices stay limited until data returns.');
  });

  it('reports over-hard-cap before active limiting', () => {
    expect(buildDecisionSentence(baseline({
      overHardLimit: true,
      limitedCount: 2,
    })).text).toBe('Over the hard cap right now. Easing devices off.');
  });

  it('uses hypothetical voice in simulation mode', () => {
    expect(buildDecisionSentence(baseline({
      dryRun: true,
      limitedCount: 2,
    })).text).toBe('2 devices would be limited if simulation mode were off.');
  });

  it('names the house and the safe-pace target when actively limiting', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 4,
      safePaceKw: 12.0,
    })).text).toBe('Holding back 4 devices so the house stays under 12.0 kW.');
  });

  it('singular-form devices when only one is held', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 1,
    })).text).toBe('Holding back 1 device so the house stays under 12.0 kW.');
  });

  it('omits the safe-pace clause when the value is unavailable', () => {
    expect(buildDecisionSentence(baseline({
      limitedCount: 2,
      safePaceKw: null,
    })).text).toBe('Holding back 2 devices.');
  });

  it('describes resuming with a positive tone', () => {
    expect(buildDecisionSentence(baseline({
      resumingCount: 1,
    }))).toEqual({
      text: 'Bringing 1 device back online. Power has stayed under the safe pace.',
      positive: true,
    });
  });

  it('warns about projected overshoot without an em-dash', () => {
    expect(buildDecisionSentence(baseline({
      projectedOverBudget: true,
    })).text).toBe('On pace to overshoot this hour’s energy budget.');
  });
});

describe('formatCheapestUpcomingHour', () => {
  const clock = (timestampMs: number): string => {
    const d = new Date(timestampMs);
    return `${d.getUTCHours().toString().padStart(2, '0')}:00`;
  };

  const HOUR = 60 * 60 * 1000;
  const NOW_MS = Date.UTC(2026, 4, 17, 20, 0, 0);

  it('returns null when no hours are upcoming', () => {
    expect(formatCheapestUpcomingHour({
      hours: [{ startsAtMs: NOW_MS - HOUR, price: 5 }],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBeNull();
  });

  it('picks the cheapest upcoming hour within the default horizon', () => {
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 40 },
        { startsAtMs: NOW_MS + 6 * HOUR, price: 18 },
        { startsAtMs: NOW_MS + 12 * HOUR, price: 35 },
      ],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 02:00, 18 øre/kWh.');
  });

  it('drops hours past the horizon window', () => {
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: NOW_MS + HOUR, price: 50 },
        { startsAtMs: NOW_MS + 30 * HOUR, price: 2 }, // outside default 18h horizon
      ],
      nowMs: NOW_MS,
      unitLabel: 'øre/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 21:00, 50 øre/kWh.');
  });

  it('formats non-øre units with two decimals', () => {
    expect(formatCheapestUpcomingHour({
      hours: [{ startsAtMs: NOW_MS + HOUR, price: 1.25 }],
      nowMs: NOW_MS,
      unitLabel: 'kr/kWh',
      formatClockTime: clock,
    })).toBe('Cheapest hour ahead: 21:00, 1.25 kr/kWh.');
  });
});

describe('above-threshold subline formatters', () => {
  it('renders the overshoot kW and safe pace reference when above safe pace', () => {
    expect(formatAboveSafePaceSubline(-1.5, 5.0)).toBe('1.5 kW above safe pace (5.0 kW)');
  });

  it('clamps overshoot to zero when headroom is positive but still surfaces the reference', () => {
    expect(formatAboveSafePaceSubline(2.0, 5.0)).toBe('0.0 kW above safe pace (5.0 kW)');
  });

  it('renders overshoot kW + the hard cap value when above hard cap', () => {
    expect(formatAboveHardCapSubline(-0.5, 5.0)).toBe('0.5 kW above hard cap (5.0 kW)');
  });
});

describe('computeEnergyBarScaleKWh — projected marker alignment', () => {
  // Regression for TODO #5 (2026-05-16): when projected is below budget, the
  // marker's visual position must match the printed `projected / budget`
  // ratio. Earlier behaviour multiplied the scale by 1.05 even in the
  // under-budget branch, so the dot sat ~5 % low.
  it('uses budget as the upper bound when projected is at or below budget', () => {
    expect(computeEnergyBarScaleKWh(2.3, 1.95, 1.0)).toBe(2.3);
    // Projection / scale lines up with printed ratio (1.95 / 2.3 ≈ 0.848).
    expect(1.95 / computeEnergyBarScaleKWh(2.3, 1.95, 1.0)).toBeCloseTo(0.848, 2);
  });

  it('opens headroom past budget when projected overshoots so the overshoot is visible', () => {
    expect(computeEnergyBarScaleKWh(2.3, 2.6, 1.0)).toBeCloseTo(2.6 * 1.05, 5);
  });

  it('uses budget when projected is null and used is below budget', () => {
    expect(computeEnergyBarScaleKWh(2.3, null, 1.0)).toBe(2.3);
  });

  it('opens headroom past budget when used alone overshoots without a projection', () => {
    expect(computeEnergyBarScaleKWh(2.3, null, 2.5)).toBeCloseTo(2.5 * 1.05, 5);
  });
});
