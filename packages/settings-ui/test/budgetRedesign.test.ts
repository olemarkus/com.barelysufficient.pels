import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../contracts/src/dailyBudgetTypes';
import {
  resolveBudgetPlannedDayKWh,
  resolveChartData,
  resolveComparisonDay,
  resolveConfidenceData,
  resolveDecisionLine,
  resolveDeltaPill,
  resolveDominantCause,
  resolveEffectiveLocalView,
  resolveBudgetRemainingLine,
  resolveHeroData,
  resolvePlanPayload,
  resolveSplitLine,
} from '../src/ui/budgetRedesignResolvers.ts';
import { resolveAllocationWarning } from '../src/ui/dailyBudgetAllocationWarning.ts';
import {
  BUDGET_CHART_TITLE_HOURLY_PLAN,
  BUDGET_CHART_TITLE_PROGRESS,
  BUDGET_COMPARISON_SHOWING_TODAY,
  BUDGET_COMPARISON_SHOWING_TOMORROW,
  BUDGET_CONFIDENCE_LABEL_HIGH,
  BUDGET_CONFIDENCE_LABEL_LOW,
  BUDGET_CONFIDENCE_LABEL_MEDIUM,
  BUDGET_NO_PLAN_ENABLE_FOR_TODAY,
  BUDGET_NO_PLAN_ENABLE_FOR_TOMORROW,
  BUDGET_NO_PLAN_TODAY_PREPARING,
  BUDGET_NO_PLAN_TOMORROW_WAITING,
  BUDGET_NO_PLAN_YESTERDAY_WAITING,
  BUDGET_TOMORROW_PLAN_READY,
  BUDGET_TOMORROW_PRICE_SHAPED,
  YESTERDAY_FINISHED_OVER_BUDGET,
  YESTERDAY_FINISHED_WITHIN_BUDGET,
  composeBudgetHeroOverBy,
  composeManagedBackgroundLine,
  resolveNoPlanLine,
  resolveTomorrowLine,
} from '../../shared-domain/src/dailyBudgetHeroStrings';

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
      .toBe(BUDGET_NO_PLAN_TODAY_PREPARING);
  });

  it('asks to enable daily budget when off', () => {
    expect(resolveDecisionLine(null, 'today', 'noPlan')).toBe(BUDGET_NO_PLAN_ENABLE_FOR_TODAY);
  });

  it('points to price setup without assuming prices are the only missing tomorrow input', () => {
    expect(resolveDecisionLine(null, 'tomorrow', 'noPlan', true))
      .toBe(BUDGET_NO_PLAN_TOMORROW_WAITING);
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
      .toBe('Background usage is higher than expected today.');
  });

  it('points at device priorities when over and managed-dominant', () => {
    const payload = buildPayload({
      actualControlledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 2.0 : null)),
      actualUncontrolledKWh: Array.from({ length: 24 }, (_, i) => (i < 12 ? 0.5 : null)),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1.0),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 1.5),
    });
    expect(resolveDecisionLine(payload, 'today', 'over'))
      .toBe('Managed devices used more than expected — check device priorities.');
  });

  it('defaults to background-dominant copy when split arrays are missing', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'today', 'over'))
      .toBe('Background usage is higher than expected today.');
  });

  it('summarises yesterday outcomes', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'yesterday', 'over')).toBe(YESTERDAY_FINISHED_OVER_BUDGET);
    expect(resolveDecisionLine(payload, 'yesterday', 'within')).toBe(YESTERDAY_FINISHED_WITHIN_BUDGET);
  });

  it('points to cheaper hours for tomorrow when shaped', () => {
    const payload = buildPayload({
      priceShapingEnabled: true,
      price: Array.from({ length: 24 }, () => 1.0),
    });
    expect(resolveDecisionLine(payload, 'tomorrow', 'within'))
      .toBe(BUDGET_TOMORROW_PRICE_SHAPED);
  });

  it('uses generic ready line for tomorrow when not shaped', () => {
    const payload = buildPayload();
    expect(resolveDecisionLine(payload, 'tomorrow', 'within')).toBe(BUDGET_TOMORROW_PLAN_READY);
  });
});

describe('resolveHeroData', () => {
  it('uses persisted disabled state even when the day payload is still enabled', () => {
    const hero = resolveHeroData(buildPayload({ enabled: true }), 'today', costDisplay, 'within', false);
    expect(hero.comparison).toBe('Daily budget off');
    expect(hero.decision).toBe(BUDGET_NO_PLAN_ENABLE_FOR_TODAY);
    expect(hero.headlineLabel).toBeNull();
  });

  it('labels the today headline as projected so it does not read as used-so-far', () => {
    const payload = buildPayload();
    const hero = resolveHeroData(payload, 'today', costDisplay, 'within', true);
    expect(hero.headlineLabel).toBe('Projected today');
  });

  it("labels yesterday's headline as a finished total", () => {
    const payload = buildPayload();
    const hero = resolveHeroData(payload, 'yesterday', costDisplay, 'within', true);
    expect(hero.headlineLabel).toBe("Yesterday's total");
  });

  it("labels tomorrow's headline as planned", () => {
    const payload = buildPayload();
    const hero = resolveHeroData(payload, 'tomorrow', costDisplay, 'within', true);
    expect(hero.headlineLabel).toBe('Planned for tomorrow');
  });
});

describe('resolveChartData', () => {
  it('hides plan visuals when persisted settings say budget is disabled', () => {
    const payload = buildPayload({ enabled: true });
    expect(resolvePlanPayload(payload, false)).toBeNull();
  });

  it('uses the shared-domain chart titles so the toggle and heading stay in lockstep', () => {
    const payload = buildPayload();
    const hourly = resolveChartData(payload, 'today', 'hourlyPlan', 'within', costDisplay);
    const progress = resolveChartData(payload, 'today', 'progress', 'within', costDisplay);
    expect(hourly?.chartTitle).toBe(BUDGET_CHART_TITLE_HOURLY_PLAN);
    expect(progress?.chartTitle).toBe(BUDGET_CHART_TITLE_PROGRESS);
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
    // Confirm the pill label matches the shared-domain helper byte-for-byte so
    // a runtime log quoting the pill stays in lockstep with the UI.
    // computeProjectedUse: usedNow(25) + max(0, plannedTotal(62.4) - allowedNow(25)) = 62.4.
    const projected = 25 + Math.max(0, 24 * 2.6 - 25);
    expect(pill?.label).toBe(composeBudgetHeroOverBy(projected - 60));
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

describe('resolveBudgetRemainingLine', () => {
  it('frames positive remaining as energy left in the budget', () => {
    const payload = buildPayload({ remainingKWh: 7.7 });
    expect(resolveBudgetRemainingLine(payload, costDisplay)).toMatch(/^7\.7 kWh left in today's budget/);
  });

  it('frames negative remaining as already-used overdraw', () => {
    const payload = buildPayload({ remainingKWh: -1.3 });
    expect(resolveBudgetRemainingLine(payload, costDisplay))
      .toMatch(/^1\.3 kWh over budget already used/);
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
      label: BUDGET_CONFIDENCE_LABEL_HIGH,
      percent: '75%',
      details: [
        { label: 'Usage days', value: '12' },
        { label: 'Forecasted days', value: '4' },
        { label: 'Usage regularity', value: BUDGET_CONFIDENCE_LABEL_HIGH },
        { label: 'Managed-device fit', value: BUDGET_CONFIDENCE_LABEL_MEDIUM },
      ],
    });
  });

  it('does not round the shown percent into the next band', () => {
    const payload = buildPayload({ confidence: 0.749 });
    expect(resolveConfidenceData(payload, 'today', 'within')).toMatchObject({
      label: BUDGET_CONFIDENCE_LABEL_MEDIUM,
      percent: '74%',
    });
  });

  it('labels medium confidence from the lower threshold', () => {
    const payload = buildPayload({ confidence: 0.45 });
    expect(resolveConfidenceData(payload, 'today', 'within')?.label).toBe(BUDGET_CONFIDENCE_LABEL_MEDIUM);
    expect(resolveConfidenceData(payload, 'today', 'within')?.percent).toBe('45%');
  });

  it('labels low confidence below the medium threshold', () => {
    const payload = buildPayload({ confidence: 0.44 });
    expect(resolveConfidenceData(payload, 'today', 'within')?.label).toBe(BUDGET_CONFIDENCE_LABEL_LOW);
  });

  it('shows the main value without details when debug data is missing', () => {
    const payload = buildPayload({ confidence: 0.72 });
    expect(resolveConfidenceData(payload, 'today', 'within')).toEqual({
      label: BUDGET_CONFIDENCE_LABEL_MEDIUM,
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
    // Anchor on the shared-domain constant so a runtime log quoting the
    // comparison label stays in lockstep with the UI byte-for-byte.
    expect(result.label).toBe(BUDGET_COMPARISON_SHOWING_TOMORROW);
  });

  it('falls back to today when tomorrow payload is missing', () => {
    const today = buildDayWithPrice(reliablePrice);
    const active = wrapAsUiPayload(today, null);
    const candidate = wrapAsUiPayload(today, null);
    const result = resolveComparisonDay(active, candidate);
    expect(result.dayView).toBe('today');
    expect(result.activeDay).toBe(today);
    expect(result.label).toBe(BUDGET_COMPARISON_SHOWING_TODAY);
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
      maxFittingDailyBudgetKWh: 48,
    };
    expect(resolveAllocationWarning(payload)).toBeNull();
  });

  it('quotes the fitting daily budget when usable capacity is known', () => {
    const payload = buildPayload({ budgetKWh: 60 });
    (payload.state as { allocationPressure?: unknown }).allocationPressure = {
      requestedBudgetKWh: 12,
      plannedBudgetKWh: 4.5,
      unallocatedBudgetKWh: 7.5,
      saturationRatio: 0.375,
      constrained: true,
      maxFittingDailyBudgetKWh: 48,
    };
    const result = resolveAllocationWarning(payload);
    expect(result?.title).toBe('Daily budget exceeds what your hard cap can deliver');
    expect(result?.title).not.toMatch(/hourly/i);
    expect(result?.body).toContain('hard cap');
    expect(result?.body).not.toMatch(/hourly/i);
    expect(result?.body).toContain('60.0 kWh');
    expect(result?.body).toContain('48.0 kWh');
    expect(result?.body).toContain('shift usage to cheaper hours');
  });

  it('suppresses the warning when constrained but the configured budget is below the ceiling', () => {
    // `constrained` can fire on remaining-day saturation even when the configured
    // daily budget is below the full-day ceiling (e.g., budget burned early).
    // Lowering the setting would not help that case, so suppress the warning.
    const payload = buildPayload({ budgetKWh: 12 });
    (payload.state as { allocationPressure?: unknown }).allocationPressure = {
      requestedBudgetKWh: 8,
      plannedBudgetKWh: 2,
      unallocatedBudgetKWh: 6,
      saturationRatio: 0.25,
      constrained: true,
      maxFittingDailyBudgetKWh: 48,
    };
    expect(resolveAllocationWarning(payload)).toBeNull();
  });

  it('falls back to a generic body when usable capacity is unavailable', () => {
    const payload = buildPayload({ budgetKWh: 60 });
    (payload.state as { allocationPressure?: unknown }).allocationPressure = {
      requestedBudgetKWh: 12,
      plannedBudgetKWh: 4.5,
      unallocatedBudgetKWh: 7.5,
      saturationRatio: 0.375,
      constrained: true,
      maxFittingDailyBudgetKWh: 0,
    };
    const result = resolveAllocationWarning(payload);
    expect(result?.body).toContain('60.0 kWh');
    expect(result?.body).toContain('Lower the daily budget');
    expect(result?.body).toContain('hard cap');
    expect(result?.body).not.toMatch(/hourly/i);
    expect(result?.body).not.toContain('48.0');
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
      maxFittingDailyBudgetKWh: 48,
    };
    const result = resolveAllocationWarning(payload);
    expect(result?.body).toContain('60.0 kWh');
    expect(result?.body).not.toContain('20.0 kWh');
  });

  it('returns null for null payload', () => {
    expect(resolveAllocationWarning(null)).toBeNull();
  });
});

describe('composeBudgetHeroOverBy', () => {
  it('formats positive overage to one decimal kWh', () => {
    expect(composeBudgetHeroOverBy(3.2)).toBe('Over by 3.2 kWh');
  });

  it('rounds to one decimal so the pill matches the displayed precision', () => {
    expect(composeBudgetHeroOverBy(1.27)).toBe('Over by 1.3 kWh');
  });

  it('falls back to a placeholder when the value is not finite', () => {
    expect(composeBudgetHeroOverBy(Number.NaN)).toBe('Over by -- kWh');
    expect(composeBudgetHeroOverBy(Number.POSITIVE_INFINITY)).toBe('Over by -- kWh');
  });
});

describe('composeManagedBackgroundLine', () => {
  it('renders both totals to one decimal with the middle dot separator', () => {
    expect(composeManagedBackgroundLine(12, 18)).toBe('Managed 12.0 kWh · Background 18.0 kWh');
  });

  it('rounds each side independently to one decimal', () => {
    expect(composeManagedBackgroundLine(12.46, 18.74)).toBe('Managed 12.5 kWh · Background 18.7 kWh');
  });

  it('substitutes a placeholder for non-finite sides instead of NaN', () => {
    expect(composeManagedBackgroundLine(Number.NaN, 4)).toBe('Managed -- kWh · Background 4.0 kWh');
    expect(composeManagedBackgroundLine(4, Number.NaN)).toBe('Managed 4.0 kWh · Background -- kWh');
  });
});

describe('resolveNoPlanLine', () => {
  it('asks the user to wait for tomorrow when the feature is on', () => {
    expect(resolveNoPlanLine('tomorrow', true)).toBe(BUDGET_NO_PLAN_TOMORROW_WAITING);
  });

  it('cites missing yesterday history when the feature is on', () => {
    expect(resolveNoPlanLine('yesterday', true)).toBe(BUDGET_NO_PLAN_YESTERDAY_WAITING);
  });

  it('announces today preparation when the feature is on', () => {
    expect(resolveNoPlanLine('today', true)).toBe(BUDGET_NO_PLAN_TODAY_PREPARING);
  });

  it('nudges to enable the feature for tomorrow when off', () => {
    expect(resolveNoPlanLine('tomorrow', false)).toBe(BUDGET_NO_PLAN_ENABLE_FOR_TOMORROW);
  });

  it('nudges to enable the feature for today/yesterday when off', () => {
    expect(resolveNoPlanLine('today', false)).toBe(BUDGET_NO_PLAN_ENABLE_FOR_TODAY);
    expect(resolveNoPlanLine('yesterday', false)).toBe(BUDGET_NO_PLAN_ENABLE_FOR_TODAY);
  });
});

describe('resolveTomorrowLine', () => {
  it('names the price shift when shaping is active', () => {
    expect(resolveTomorrowLine(true)).toBe(BUDGET_TOMORROW_PRICE_SHAPED);
  });

  it('falls back to the generic ready line when shaping is not active', () => {
    expect(resolveTomorrowLine(false)).toBe(BUDGET_TOMORROW_PLAN_READY);
  });
});
