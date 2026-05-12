import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes';
import {
  resolveBudgetPlannedDayKWh,
  resolveComparisonDay,
  resolveConfidenceData,
  resolveDecisionLine,
  resolveDeltaPill,
  resolveDominantCause,
  resolveEffectiveLocalView,
  resolveHeadroomLine,
  resolveHeroData,
  resolvePlanPayload,
  resolveSplitLine,
} from '../src/ui/budgetRedesign.ts';
import { resolveAllocationWarning } from '../src/ui/dailyBudgetAllocationWarning.ts';

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
  confidence?: number;
  confidenceDebug?: DailyBudgetDayPayload['state']['confidenceDebug'];
  enabled?: boolean;
} = {}): DailyBudgetDayPayload => ({
  dateKey: '2026-05-11',
  timeZone: 'Europe/Oslo',
  nowUtc: '2026-05-11T12:00:00Z',
  dayStartUtc: '2026-05-10T22:00:00Z',
  currentBucketIndex: overrides.currentBucketIndex ?? 12,
  budget: {
    enabled: overrides.enabled ?? true,
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
    confidence: overrides.confidence ?? 1,
    priceShapingActive: false,
    ...(overrides.confidenceDebug ? { confidenceDebug: overrides.confidenceDebug } : {}),
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
    expect(resolveDecisionLine(enabledPayload, 'today', 'noPlan'))
      .toBe('PELS is preparing the daily plan. Check again shortly.');
  });

  it('asks to enable daily budget when off', () => {
    expect(resolveDecisionLine(null, 'today', 'noPlan')).toBe('Enable daily budget to build a daily plan.');
  });

  it('points to price setup without assuming prices are the only missing tomorrow input', () => {
    expect(resolveDecisionLine(null, 'tomorrow', 'noPlan', true))
      .toBe("Tomorrow's plan is not available yet. Check electricity prices if it does not appear shortly.");
  });

  it('does not imply budget is off when persisted settings say it is enabled', () => {
    expect(resolveDecisionLine(null, 'today', 'noPlan', true)).not.toContain('Enable daily budget');
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

describe('resolveHeroData', () => {
  it('uses persisted disabled state even when the day payload is still enabled', () => {
    const hero = resolveHeroData(buildPayload({ enabled: true }), 'today', costDisplay, 'within', false);
    expect(hero.comparison).toBe('Daily budget off');
    expect(hero.decision).toBe('Enable daily budget to build a daily plan.');
  });
});

describe('resolveChartData', () => {
  it('hides plan visuals when persisted settings say budget is disabled', () => {
    const payload = buildPayload({ enabled: true });
    expect(resolvePlanPayload(payload, false)).toBeNull();
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
  it('frames positive remaining as energy to spare', () => {
    const payload = buildPayload({ remainingKWh: 7.7 });
    expect(resolveHeadroomLine(payload, costDisplay)).toMatch(/^7\.7 kWh to spare now/);
  });

  it('frames negative remaining as overdraw rather than negative spare energy', () => {
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

describe('resolveConfidenceData', () => {
  const confidenceDebug = {
    confidenceRegularity: 0.82,
    confidenceAdaptability: 0.6,
    confidenceAdaptabilityInfluence: 0.3,
    confidenceWeightedControlledShare: 0.25,
    confidenceValidActualDays: 12,
    confidenceValidPlannedDays: 4,
    confidenceBootstrapLow: 0.45,
    confidenceBootstrapHigh: 0.75,
    profileBlendConfidence: 0.72,
  };

  it('labels high confidence at the upper threshold', () => {
    const payload = buildPayload({ confidence: 0.75, confidenceDebug });
    expect(resolveConfidenceData(payload, 'today', 'within')).toEqual({
      label: 'High',
      percent: '75%',
      details: [
        { label: 'Usage days', value: '12' },
        { label: 'Planned days', value: '4' },
        { label: 'Usage regularity', value: 'High' },
        { label: 'Managed-device fit', value: 'Medium' },
      ],
    });
  });

  it('does not round the shown percent into the next band', () => {
    const payload = buildPayload({ confidence: 0.749 });
    expect(resolveConfidenceData(payload, 'today', 'within')).toMatchObject({
      label: 'Medium',
      percent: '74%',
    });
  });

  it('labels medium confidence from the lower threshold', () => {
    const payload = buildPayload({ confidence: 0.45 });
    expect(resolveConfidenceData(payload, 'today', 'within')?.label).toBe('Medium');
    expect(resolveConfidenceData(payload, 'today', 'within')?.percent).toBe('45%');
  });

  it('labels low confidence below the medium threshold', () => {
    const payload = buildPayload({ confidence: 0.44 });
    expect(resolveConfidenceData(payload, 'today', 'within')?.label).toBe('Low');
  });

  it('shows the main value without details when debug data is missing', () => {
    const payload = buildPayload({ confidence: 0.72 });
    expect(resolveConfidenceData(payload, 'today', 'within')).toEqual({
      label: 'Medium',
      percent: '72%',
      details: [],
    });
  });

  it('hides confidence when the value is missing', () => {
    const payload = buildPayload({ confidence: Number.NaN });
    expect(resolveConfidenceData(payload, 'today', 'within')).toBeNull();
  });

  it('hides confidence outside today', () => {
    const payload = buildPayload({ confidence: 0.72 });
    expect(resolveConfidenceData(payload, 'tomorrow', 'within')).toBeNull();
    expect(resolveConfidenceData(payload, 'yesterday', 'within')).toBeNull();
  });

  it('hides confidence when daily budget is off or no plan exists', () => {
    expect(resolveConfidenceData(buildPayload({ enabled: false }), 'today', 'noPlan')).toBeNull();
    expect(resolveConfidenceData(buildPayload({ confidence: 0.72 }), 'today', 'noPlan')).toBeNull();
  });

  it('hides confidence when persisted settings say budget is disabled', () => {
    const payload = resolvePlanPayload(buildPayload({ enabled: true, confidence: 0.72 }), false);
    expect(resolveConfidenceData(payload, 'today', 'within')).toBeNull();
  });
});

describe('resolveEffectiveLocalView', () => {
  it('honours the requested view when the budget feature is on', () => {
    expect(resolveEffectiveLocalView(true, 'plan')).toBe('plan');
    expect(resolveEffectiveLocalView(true, 'adjust')).toBe('adjust');
  });

  it('forces the adjust view when the feature is off so the enable toggle surfaces', () => {
    expect(resolveEffectiveLocalView(false, 'plan')).toBe('adjust');
    expect(resolveEffectiveLocalView(false, 'adjust')).toBe('adjust');
  });
});

describe('resolveComparisonDay', () => {
  const buildDayWithPrice = (price: Array<number | null>): DailyBudgetDayPayload => buildPayload({
    plannedKWh: Array.from({ length: 24 }, () => 1),
    price,
  });

  const wrapAsUiPayload = (
    todayDay: DailyBudgetDayPayload,
    tomorrowDay: DailyBudgetDayPayload | null,
  ): DailyBudgetUiPayload => ({
    days: {
      '2026-05-11': todayDay,
      ...(tomorrowDay ? { '2026-05-12': tomorrowDay } : {}),
    },
    todayKey: '2026-05-11',
    tomorrowKey: tomorrowDay ? '2026-05-12' : null,
    yesterdayKey: null,
  });

  const reliablePrice = Array.from({ length: 24 }, (_, i) => 0.5 + (i % 12) * 0.02);

  it('routes to tomorrow when both active and candidate have reliable tomorrow prices', () => {
    const today = buildDayWithPrice(reliablePrice);
    const tomorrow = buildDayWithPrice(reliablePrice);
    const active = wrapAsUiPayload(today, tomorrow);
    const candidate = wrapAsUiPayload(today, tomorrow);
    const result = resolveComparisonDay(active, candidate);
    expect(result.dayView).toBe('tomorrow');
    expect(result.activeDay).toBe(tomorrow);
    expect(result.candidateDay).toBe(tomorrow);
    expect(result.label).toMatch(/tomorrow/i);
  });

  it('falls back to today when tomorrow payload is missing', () => {
    const today = buildDayWithPrice(reliablePrice);
    const active = wrapAsUiPayload(today, null);
    const candidate = wrapAsUiPayload(today, null);
    const result = resolveComparisonDay(active, candidate);
    expect(result.dayView).toBe('today');
    expect(result.activeDay).toBe(today);
    expect(result.label).toMatch(/today/i);
    expect(result.label).toMatch(/not yet available/i);
  });

  it("falls back to today when tomorrow's prices are not reliable", () => {
    const today = buildDayWithPrice(reliablePrice);
    const tomorrowWithNullPrice = buildDayWithPrice(Array.from({ length: 24 }, () => null));
    const active = wrapAsUiPayload(today, tomorrowWithNullPrice);
    const candidate = wrapAsUiPayload(today, tomorrowWithNullPrice);
    const result = resolveComparisonDay(active, candidate);
    expect(result.dayView).toBe('today');
  });

  it('falls back to today when one side has tomorrow prices and the other does not', () => {
    const today = buildDayWithPrice(reliablePrice);
    const tomorrowReliable = buildDayWithPrice(reliablePrice);
    const tomorrowUnreliable = buildDayWithPrice(Array.from({ length: 24 }, () => null));
    const active = wrapAsUiPayload(today, tomorrowReliable);
    const candidate = wrapAsUiPayload(today, tomorrowUnreliable);
    const result = resolveComparisonDay(active, candidate);
    expect(result.dayView).toBe('today');
  });
});

describe('resolveAllocationWarning', () => {
  it('returns null when no allocation pressure is present', () => {
    const payload = buildPayload();
    expect(resolveAllocationWarning(payload)).toBeNull();
  });

  it('returns null when pressure is not constrained', () => {
    const payload = buildPayload();
    (payload.state as { allocationPressure?: unknown }).allocationPressure = {
      requestedBudgetKWh: 12,
      plannedBudgetKWh: 12,
      unallocatedBudgetKWh: 0,
      saturationRatio: 0,
      constrained: false,
    };
    expect(resolveAllocationWarning(payload)).toBeNull();
  });

  it('returns layman title and body when constrained', () => {
    const payload = buildPayload({ budgetKWh: 60 });
    (payload.state as { allocationPressure?: unknown }).allocationPressure = {
      requestedBudgetKWh: 12,
      plannedBudgetKWh: 4.5,
      unallocatedBudgetKWh: 7.5,
      saturationRatio: 0.375,
      constrained: true,
    };
    const result = resolveAllocationWarning(payload);
    expect(result?.title).toContain('larger than your hourly limit');
    expect(result?.body).toContain('daily budget of 60.0 kWh');
    expect(result?.body).toContain('Lower the daily budget');
  });

  it('quotes the configured daily budget, not the remaining requestedBudgetKWh', () => {
    // requestedBudgetKWh is the remaining budget after consumption (see
    // computeAllocationPressure in lib/dailyBudget/dailyBudgetState.ts) — mid-day
    // it diverges from payload.budget.dailyBudgetKWh. The warning must show
    // the configured value so the user can match it to their setting.
    const payload = buildPayload({ budgetKWh: 60 });
    (payload.state as { allocationPressure?: unknown }).allocationPressure = {
      requestedBudgetKWh: 20,
      plannedBudgetKWh: 5,
      unallocatedBudgetKWh: 15,
      saturationRatio: 0.25,
      constrained: true,
    };
    const result = resolveAllocationWarning(payload);
    expect(result?.body).toContain('60.0 kWh');
    expect(result?.body).not.toContain('20.0 kWh');
  });

  it('returns null for null payload', () => {
    expect(resolveAllocationWarning(null)).toBeNull();
  });
});
