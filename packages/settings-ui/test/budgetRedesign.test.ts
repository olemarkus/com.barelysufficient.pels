import type { DailyBudgetDayPayload } from '../../contracts/src/dailyBudgetTypes';
import {
  resolveBudgetPlannedDayKWh,
  resolveDecisionLine,
  resolveDeltaPill,
  resolveDominantCause,
  resolveHeadroomLine,
  resolveSplitLine,
} from '../src/ui/budgetRedesign.ts';

const costDisplay = { unit: 'kr', divisor: 100 } as const;

const enabledPayload = {
  budget: { enabled: true },
} as unknown as DailyBudgetDayPayload;

const buildPayload = (overrides: {
  budgetKWh?: number;
  priceShapingEnabled?: boolean;
  plannedKWh?: number[];
  actualKWh?: number[];
  actualControlledKWh?: Array<number | null>;
  actualUncontrolledKWh?: Array<number | null>;
  plannedControlledKWh?: number[];
  plannedUncontrolledKWh?: number[];
  price?: Array<number | null>;
  currentBucketIndex?: number;
  remainingKWh?: number;
} = {}): DailyBudgetDayPayload => ({
  dateKey: '2026-05-11',
  timeZone: 'Europe/Oslo',
  nowUtc: '2026-05-11T12:00:00Z',
  dayStartUtc: '2026-05-10T22:00:00Z',
  currentBucketIndex: overrides.currentBucketIndex ?? 12,
  budget: {
    enabled: true,
    dailyBudgetKWh: overrides.budgetKWh ?? 60,
    priceShapingEnabled: overrides.priceShapingEnabled ?? false,
  },
  state: {
    usedNowKWh: 25,
    allowedNowKWh: 25,
    remainingKWh: overrides.remainingKWh ?? 35,
    deviationKWh: 0,
    exceeded: false,
    frozen: false,
    confidence: 1,
    priceShapingActive: false,
  },
  buckets: {
    startUtc: [],
    startLocalLabels: [],
    plannedWeight: [],
    plannedKWh: overrides.plannedKWh ?? Array.from({ length: 24 }, () => 2.5),
    actualKWh: overrides.actualKWh ?? Array.from({ length: 24 }, (_, i) => (i < 12 ? 2.1 : 0)),
    plannedControlledKWh: overrides.plannedControlledKWh
      ?? Array.from({ length: 24 }, () => 0),
    plannedUncontrolledKWh: overrides.plannedUncontrolledKWh
      ?? (overrides.plannedKWh ?? Array.from({ length: 24 }, () => 2.5)),
    actualControlledKWh: overrides.actualControlledKWh
      ?? Array.from({ length: 24 }, () => null),
    actualUncontrolledKWh: overrides.actualUncontrolledKWh
      ?? Array.from({ length: 24 }, () => null),
    allowedCumKWh: [],
    price: overrides.price,
  },
} as DailyBudgetDayPayload);

describe('resolveDecisionLine', () => {
  it('asks to wait when budget is enabled but data is missing', () => {
    expect(resolveDecisionLine(enabledPayload, 'today', 'noPlan')).toBe('Waiting for daily budget data.');
  });

  it('asks to enable daily budget when off', () => {
    expect(resolveDecisionLine(null, 'today', 'noPlan')).toBe('Enable daily budget to build a daily plan.');
  });

  it('is silent on within-budget today', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'today', 'within')).toBeNull();
  });

  it('cites background usage when tight and background-dominant', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.4 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 1.7 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDecisionLine(payload, 'today', 'tight'))
      .toBe('Close to budget — driven by background usage.');
  });

  it('credits PELS shaping when tight and managed-dominant', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 1.5 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.6 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDecisionLine(payload, 'today', 'tight'))
      .toBe('PELS is shaping flexible use to stay within budget.');
  });

  it('blames background when over and background-dominant', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.4 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 2.0 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDecisionLine(payload, 'today', 'over'))
      .toBe('Background usage is above plan today.');
  });

  it('points at device priorities when over and managed-dominant', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 2.0 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.5 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDecisionLine(payload, 'today', 'over'))
      .toBe('Managed devices ran above plan — check device priorities.');
  });

  it('defaults to background-dominant copy when split arrays are missing', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'today', 'over'))
      .toBe('Background usage is above plan today.');
  });

  it('summarises yesterday outcomes', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'yesterday', 'over')).toBe('Yesterday finished over budget.');
    expect(resolveDecisionLine(payload, 'yesterday', 'within')).toBe('Yesterday finished within budget.');
  });

  it('points to cheaper hours for tomorrow when shaped', () => {
    const payload = buildPayload({
      priceShapingEnabled: true,
      price: Array.from({ length: 24 }, () => 1.0),
    });
    expect(resolveDecisionLine(payload, 'tomorrow', 'within'))
      .toBe('Most planned use is shifted toward cheaper hours.');
  });

  it('uses generic ready line for tomorrow when not shaped', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'tomorrow', 'within')).toBe("Tomorrow's budget plan is ready.");
  });
});

describe('resolveDeltaPill', () => {
  it('returns alert pill with delta for over budget today', () => {
    const payload = buildPayload({
      plannedKWh: Array.from({ length: 24 }, () => 2.6),
      actualKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 2.6 : 0)),
    });
    const pill = resolveDeltaPill(payload, 'today', 'over');
    expect(pill?.tone).toBe('alert');
    expect(pill?.label).toMatch(/^Over by /);
  });

  it('returns warn pill labelled "Close to budget" for tight', () => {
    const payload = buildPayload();
    expect(resolveDeltaPill(payload, 'today', 'tight')).toEqual({
      label: 'Close to budget',
      tone: 'warn',
    });
  });

  it('returns ok pill with headroom for within today', () => {
    const payload = buildPayload({
      plannedKWh: Array.from({ length: 24 }, () => 1.0),
    });
    const pill = resolveDeltaPill(payload, 'today', 'within');
    expect(pill?.tone).toBe('ok');
    expect(pill?.label).toMatch(/kWh to spare$/);
  });

  it('reports yesterday under savings as ok pill', () => {
    const payload = buildPayload({
      actualKWh: Array.from({ length: 24 }, () => 2.0),
    });
    const pill = resolveDeltaPill(payload, 'yesterday', 'within');
    expect(pill?.tone).toBe('ok');
    expect(pill?.label).toMatch(/kWh under$/);
  });
});

describe('resolveSplitLine', () => {
  it('renders managed and background totals when split arrays present', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 1.0 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 1.5 : null)),
    });
    expect(resolveSplitLine(payload)).toBe('Managed 12.0 kWh · Background 18.0 kWh');
  });

  it('zero-fills managed when split arrays are missing', () => {
    const payload = buildPayload();
    expect(resolveSplitLine(payload)).toMatch(/^Managed 0\.0 kWh · Background /);
  });

  it('includes the in-progress current bucket so the split tracks the headline', () => {
    const payload = buildPayload({
      currentBucketIndex: 12,
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => {
        if (i < 12) return 1.0;
        if (i === 12) return 0.5;
        return null;
      }),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => {
        if (i < 12) return 1.5;
        if (i === 12) return 0.7;
        return null;
      }),
    });
    expect(resolveSplitLine(payload)).toBe('Managed 12.5 kWh · Background 18.7 kWh');
  });
});

describe('resolveDominantCause', () => {
  it('returns background when actual background share exceeds plan', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.4 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 1.7 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDominantCause(payload)).toBe('background');
  });

  it('returns managed when background share is in line with plan', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 1.5 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.6 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDominantCause(payload)).toBe('managed');
  });

  it('defaults to background when split arrays are missing', () => {
    const payload = buildPayload();
    expect(resolveDominantCause(payload)).toBe('background');
  });

  it('lets the current bucket flip the dominant-cause judgment', () => {
    const payload = buildPayload({
      currentBucketIndex: 12,
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => {
        if (i < 12) return 1.5;
        if (i === 12) return 0.0;
        return null;
      }),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => {
        if (i < 12) return 0.6;
        if (i === 12) return 50.0;
        return null;
      }),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    // Buckets 0..11 alone would be managed-dominant (0.6/(1.5+0.6) = 0.286 vs
    // planned 0.6). Including the in-progress bucket 12 pushes the background
    // share past the planned threshold, flipping the cause to background.
    expect(resolveDominantCause(payload)).toBe('background');
  });
});

describe('resolveHeadroomLine', () => {
  it('frames positive remaining as headroom', () => {
    const payload = buildPayload({ remainingKWh: 7.7 });
    expect(resolveHeadroomLine(payload, costDisplay)).toMatch(/^7\.7 kWh headroom now/);
  });

  it('frames negative remaining as overdraw rather than negative headroom', () => {
    const payload = buildPayload({ remainingKWh: -1.3 });
    expect(resolveHeadroomLine(payload, costDisplay))
      .toMatch(/^1\.3 kWh over budget now/);
  });
});

describe('resolveBudgetPlannedDayKWh', () => {
  it('uses the actual planned bucket total for day plan summaries', () => {
    const payload = {
      buckets: { plannedKWh: [2, 1.5, 0.5] },
    } as unknown as DailyBudgetDayPayload;
    expect(resolveBudgetPlannedDayKWh(payload)).toBe(4);
  });
});
