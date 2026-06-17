import {
  buildBudgetHourlyReadoutBundle,
  buildBudgetProgressReadoutBundle,
  buildProjectionCumulative,
  resolveBudgetDefaultReadoutIndex,
  resolveProgressSeriesData,
} from '../src/ui/budgetRedesignChartData.ts';
import { buildProgressOption, type BudgetChartPalette } from '../src/ui/budgetRedesignChartOptions.ts';
import type { DailyBudgetDayPayload } from '../../contracts/src/dailyBudgetTypes.ts';

// Measurement segments join their tokens with NBSP (wraps happen only at
// the separators) — mirror the production join so the exact-string
// assertions below stay byte-accurate. `sep` is the forward-binding
// separator (regular space, then `·` glued forward with NBSP).
const nb = (text: string): string => text.split(' ').join(' ');
const sep = ' ·\u00A0';

// Minimal 4-bucket day payload. Labels use the runtime producer's `HH:MM`
// shape; bucket-specific overrides patch the fields under test.
const buildDayPayload = (overrides: {
  currentBucketIndex?: number;
  buckets?: Partial<DailyBudgetDayPayload['buckets']>;
} = {}): DailyBudgetDayPayload => ({
  dateKey: '2026-06-11',
  timeZone: 'Europe/Oslo',
  nowUtc: '2026-06-11T12:30:00.000Z',
  dayStartUtc: '2026-06-10T22:00:00.000Z',
  currentBucketIndex: overrides.currentBucketIndex ?? 1,
  budget: { enabled: true, dailyBudgetKWh: 12, priceShapingEnabled: true },
  state: {
    usedNowKWh: 1,
    allowedNowKWh: 1.2,
    remainingKWh: 11,
    deviationKWh: -0.2,
    exceeded: false,
    frozen: false,
    confidence: 0.7,
    priceShapingActive: true,
  },
  buckets: {
    startUtc: [
      '2026-06-11T10:00:00.000Z',
      '2026-06-11T11:00:00.000Z',
      '2026-06-11T12:00:00.000Z',
      '2026-06-11T13:00:00.000Z',
    ],
    startLocalLabels: ['12:00', '13:00', '14:00', '15:00'],
    plannedWeight: [1, 1, 1, 1],
    plannedKWh: [0.5, 0.92, 0.6, 0.4],
    plannedUncontrolledKWh: [0.2, 0.41, 0.3, 0.2],
    plannedControlledKWh: [0.3, 0.51, 0.3, 0.2],
    actualKWh: [0.45, 0.71, 0.2, 0],
    actualControlledKWh: [0.25, 0.4, null, null],
    actualUncontrolledKWh: [0.2, 0.31, null, null],
    allowedCumKWh: [0.5, 1.42, 2.02, 2.42],
    price: [70, 84, 90, 60],
    ...overrides.buckets,
  },
});

describe('budget readout content (progress mode)', () => {
  it('formats the cumulative plan/actual line and the projection when present', () => {
    // currentBucketIndex 1 on today: actual covers buckets 0-1, projection
    // starts at the current bucket.
    const bundle = buildBudgetProgressReadoutBundle(buildDayPayload(), 'today');
    expect(bundle.readouts[1]).toEqual({
      when: 'By 14:00',
      values: [
        { text: `${nb('Budget 1.4 kWh')}${sep}${nb('Actual 1.2 kWh')}` },
        { text: nb('Projection 1.4 kWh') },
      ],
    });
  });

  it('omits actual and projection on the tomorrow view', () => {
    const bundle = buildBudgetProgressReadoutBundle(buildDayPayload(), 'tomorrow');
    expect(bundle.readouts[1]).toEqual({
      when: 'By 14:00',
      values: [{ text: nb('Budget 1.4 kWh') }],
    });
  });

  it('omits the projection for completed hours and closes the day at midnight', () => {
    const bundle = buildBudgetProgressReadoutBundle(buildDayPayload(), 'yesterday');
    // Yesterday: every bucket has actual, none has a projection.
    expect(bundle.readouts[0]).toEqual({
      when: 'By 13:00',
      values: [{ text: `${nb('Budget 0.5 kWh')}${sep}${nb('Actual 0.5 kWh')}` }],
    });
    // The cumulative end-of-day column reads "By midnight" — "By 00:00"
    // misreads as the day's start. The hourly range form keeps `…–00:00`.
    expect(bundle.readouts[3].when).toBe('By midnight');
  });

  it('anchors non-today views on the end-of-day column and today on the current hour', () => {
    // The cumulative chart's answer for a finished (or fully planned) day is
    // its total — the end-of-day column — not its peak hour.
    expect(buildBudgetProgressReadoutBundle(buildDayPayload(), 'yesterday').defaultIndex).toBe(3);
    expect(buildBudgetProgressReadoutBundle(buildDayPayload(), 'tomorrow').defaultIndex).toBe(3);
    expect(buildBudgetProgressReadoutBundle(buildDayPayload(), 'today').defaultIndex).toBe(1);
  });

  it('skips the native select dispatch and carries marker values instead', () => {
    const bundle = buildBudgetProgressReadoutBundle(buildDayPayload(), 'today');
    expect(bundle.selectSeriesIndexes).toEqual([]);
    // Marker prefers the actual cumulative where present, then projection
    // (1.37 at the current bucket + 0.6 + 0.4 planned thereafter).
    expect(bundle.markerValues?.[0]).toBeCloseTo(0.45, 5);
    expect(bundle.markerValues?.[3]).toBeCloseTo(2.37, 5);
  });
});

describe('budget readout content (hourly mode)', () => {
  const costDisplay = { unit: 'kr', divisor: 100 };

  it('formats plan with the managed/background split, price, and actual', () => {
    const bundle = buildBudgetHourlyReadoutBundle({
      payload: buildDayPayload(),
      view: 'today',
      priceReliable: true,
      costDisplay,
    });
    expect(bundle.readouts[1]).toEqual({
      when: '13:00–14:00',
      values: [
        { text: `${nb('Budget 0.92 kWh')} ${nb('(Managed 0.51')}${sep}${nb('Background 0.41)')}` },
        { text: nb('Price 0.84 kr/kWh') },
        { text: nb('Actual 0.71 kWh') },
      ],
    });
    // Both stacked bar series carry the select border.
    expect(bundle.selectSeriesIndexes).toEqual([0, 1]);
    expect(bundle.markerValues).toBeNull();
  });

  it('omits actual beyond the current bucket and price when unreliable', () => {
    const bundle = buildBudgetHourlyReadoutBundle({
      payload: buildDayPayload(),
      view: 'today',
      priceReliable: false,
      costDisplay,
    });
    expect(bundle.readouts[2]).toEqual({
      when: '14:00–15:00',
      values: [
        { text: `${nb('Budget 0.60 kWh')} ${nb('(Managed 0.30')}${sep}${nb('Background 0.30)')}` },
      ],
    });
  });

  it('falls back to the single Budget line when the split is missing', () => {
    const bundle = buildBudgetHourlyReadoutBundle({
      payload: buildDayPayload({
        buckets: { plannedControlledKWh: [], plannedUncontrolledKWh: [] },
      }),
      view: 'tomorrow',
      priceReliable: false,
      costDisplay,
    });
    expect(bundle.readouts[1]).toEqual({
      when: '13:00–14:00',
      values: [{ text: nb('Budget 0.92 kWh') }],
    });
    expect(bundle.selectSeriesIndexes).toEqual([0]);
  });
});

describe('resolveBudgetDefaultReadoutIndex', () => {
  it('defaults to the current hour on today and clamps to the data', () => {
    expect(resolveBudgetDefaultReadoutIndex(buildDayPayload(), 'today')).toBe(1);
    expect(resolveBudgetDefaultReadoutIndex(buildDayPayload({ currentBucketIndex: 99 }), 'today')).toBe(3);
  });

  it('defaults to the peak actual hour on yesterday and the peak planned hour on tomorrow', () => {
    // Hourly-mode default; the progress bundle overrides non-today views
    // with the end-of-day column (asserted above).
    expect(resolveBudgetDefaultReadoutIndex(buildDayPayload(), 'yesterday')).toBe(1);
    expect(resolveBudgetDefaultReadoutIndex(buildDayPayload(), 'tomorrow')).toBe(1);
  });
});

describe('buildProgressOption', () => {
  const palette: BudgetChartPalette = {
    actual: '#a1',
    plan: '#a2',
    planFill: '#a3',
    background: '#a4',
    managed: '#a5',
    forecast: '#a6',
    priceLine: '#a7',
    priceFill: '#a8',
    muted: '#a9',
    grid: '#aa',
    overBudget: '#ab',
    text: '#ac',
    tooltipBackground: '#ad',
    tooltipText: '#ae',
    tooltipBorder: '#af',
  };

  it('marks the daily budget with an end-stop on the Budget pace curve', () => {
    const option = buildProgressOption({
      payload: buildDayPayload(),
      view: 'today',
      palette,
      readouts: [],
    });
    const budgetSeries = (option.series as Array<Record<string, unknown>>)
      .find((series) => series.name === 'Budget');
    expect(budgetSeries).toBeDefined();
    const markPoint = budgetSeries?.markPoint as { label?: { formatter?: string } } | undefined;
    expect(markPoint?.label?.formatter).toMatch(/^Budget \d+\.\d kWh$/);
  });

  it('omits the budget end-stop when no positive daily budget is set', () => {
    const payload = buildDayPayload();
    payload.budget = { ...payload.budget, dailyBudgetKWh: 0 };
    const option = buildProgressOption({ payload, view: 'today', palette, readouts: [] });
    const budgetSeries = (option.series as Array<Record<string, unknown>>)
      .find((series) => series.name === 'Budget');
    expect(budgetSeries?.markPoint).toBeUndefined();
  });
});

describe('Budget redesign chart helpers', () => {
  it('includes the current-hour remainder in the today projection', () => {
    expect(buildProjectionCumulative({
      planned: [1, 1, 1],
      actualCumulative: [0.4, null, null],
      actualUpToIndex: 0,
      view: 'today',
    })).toEqual([1, 2, 3]);
  });

  it('does not subtract over-plan current-hour usage from the projection', () => {
    expect(buildProjectionCumulative({
      planned: [1, 1, 1],
      actualCumulative: [1.2, null, null],
      actualUpToIndex: 0,
      view: 'today',
    })).toEqual([1.2, 2.2, 3.2]);
  });
});

describe('resolveProgressSeriesData — producer trust + fallback', () => {
  it('uses the producer budget-pace and projection series verbatim when valid', () => {
    const series = resolveProgressSeriesData(buildDayPayload({
      buckets: {
        budgetPaceCumKWh: [1, 2, 3, 4],
        projectionCumKWh: [10, 20, 30, 40],
      },
    }), 'today');
    expect(series.planCumulative).toEqual([1, 2, 3, 4]);
    // currentBucketIndex 1 ⇒ projection masked before "now", drawn from there on.
    expect(series.projection).toEqual([null, 20, 30, 40]);
  });

  it.each([
    ['empty', []],
    ['short', [1, 2, 3]],
    ['non-finite', [1, 2, Number.NaN, 4]],
  ])('falls back to the local plan cumulative when budgetPaceCumKWh is %s', (_label, pace) => {
    const series = resolveProgressSeriesData(buildDayPayload({
      buckets: { budgetPaceCumKWh: pace },
    }), 'today');
    // cumulative([0.5, 0.92, 0.6, 0.4]) — the legacy recompute, never the bad array.
    expect(series.planCumulative).toEqual([0.5, 1.42, 2.02, 2.42]);
  });

  it('falls back to the local projection when projectionCumKWh is empty', () => {
    const producerEmpty = resolveProgressSeriesData(buildDayPayload({
      buckets: { projectionCumKWh: [] },
    }), 'today');
    const localOnly = resolveProgressSeriesData(buildDayPayload(), 'today');
    expect(producerEmpty.projection).toEqual(localOnly.projection);
  });

  it('draws no projection before the first actual lands (cold start)', () => {
    const series = resolveProgressSeriesData(buildDayPayload({
      currentBucketIndex: -1,
      buckets: { projectionCumKWh: [10, 20, 30, 40] },
    }), 'today');
    expect(series.projection).toEqual([null, null, null, null]);
  });
});
