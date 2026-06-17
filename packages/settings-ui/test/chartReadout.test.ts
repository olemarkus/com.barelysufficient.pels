// Phase 3 chart interaction grammar: structured readout content resolvers
// (exact user-facing strings) + the pinned-readout primitive's selection
// lifecycle against a scripted chart double.
import { attachChartReadout, resolveGridCellFromPixel } from '../src/ui/chartReadout.ts';
import {
  buildBudgetHourlyReadout,
  buildBudgetProgressReadout,
  buildDailyHistoryReadout,
  buildHourlyPatternReadout,
  buildPowerWeekReadout,
  buildUsageDayReadout,
  readoutToTooltipHtml,
  resolveTooltipDataIndex,
} from '../src/ui/chartTooltipFormat.ts';
import { buildUsageDayBucketReadout } from '../src/ui/usageDayView.ts';
import { buildPowerWeekDayLabel } from '../src/ui/powerWeekChartEcharts.ts';
import type { EChartsType } from '../src/ui/echartsRegistry.ts';

// Measurement segments join their tokens with NBSP (wraps happen only at the
// separators) — mirror the production join so the exact-string assertions
// below stay byte-accurate. `sep` is the forward-binding separator (regular
// space, then `·` glued to the FOLLOWING segment with NBSP).
const nb = (text: string): string => text.split(' ').join(' ');
const sep = ' ·\u00A0';

describe('chart readout content resolvers', () => {
  it('formats the hourly pattern readout as hour range + average', () => {
    expect(buildHourlyPatternReadout({ hour: 13, avg: 1.24 })).toEqual({
      when: '13:00–14:00',
      values: [{ text: nb('Average 1.24 kWh') }],
    });
  });

  it('wraps the hourly pattern range across midnight', () => {
    expect(buildHourlyPatternReadout({ hour: 23, avg: 0.5 }).when).toBe('23:00–00:00');
  });

  it('formats the daily history readout without budget context when no budget is set', () => {
    expect(buildDailyHistoryReadout({ dateLabel: 'Thu 4 Jun', kWh: 12.6, budgetKWh: null })).toEqual({
      when: 'Thu 4 Jun',
      values: [{ text: nb('12.6 kWh') }],
    });
  });

  it('adds a warn-toned over-budget line when the day exceeds the budget', () => {
    expect(buildDailyHistoryReadout({ dateLabel: 'Thu 4 Jun', kWh: 15.2, budgetKWh: 14 })).toEqual({
      when: 'Thu 4 Jun',
      values: [
        { text: nb('15.2 kWh') },
        { text: nb('1.2 kWh over budget'), tone: 'warn' },
      ],
    });
  });

  it('adds a within-budget line when the day stays under the budget', () => {
    expect(buildDailyHistoryReadout({ dateLabel: 'Thu 4 Jun', kWh: 12.6, budgetKWh: 14 })).toEqual({
      when: 'Thu 4 Jun',
      values: [
        { text: nb('12.6 kWh') },
        { text: nb('Within budget of 14.0 kWh') },
      ],
    });
  });

  it('uses the stored budget value even below the adjust slider floor', () => {
    // Regression: the budget context must come from the active budget, not
    // the budget-adjust draft (which clamps a stored 12 kWh up to 20 on read).
    expect(buildDailyHistoryReadout({ dateLabel: 'Thu 4 Jun', kWh: 9.5, budgetKWh: 12 }).values).toEqual([
      { text: nb('9.5 kWh') },
      { text: nb('Within budget of 12.0 kWh') },
    ]);
  });

  it('marks the window-clipped oldest day as a partial day', () => {
    expect(buildDailyHistoryReadout({
      dateLabel: 'Thu 4 Jun',
      kWh: 9.1,
      budgetKWh: null,
      partialDay: true,
    }).values).toEqual([{ text: nb('9.1 kWh (partial day)') }]);
  });

  it('formats the usage day readout with the managed/background split and warning', () => {
    expect(buildUsageDayReadout({
      hourRange: '13:00–14:00',
      measuredKWh: 1.31,
      managedKWh: 0.8,
      backgroundKWh: 0.51,
      unreliable: true,
    })).toEqual({
      when: '13:00–14:00',
      values: [
        { text: nb('Measured 1.31 kWh') },
        // NBSP inside each half; the separator's leading space is the wrap
        // opportunity, with the dot bound to the following half.
        { text: `${nb('Managed 0.80 kWh')}${sep}${nb('Background 0.51 kWh')}` },
        // Prose warning keeps normal spaces (no unit to orphan; must stay
        // wrappable at 320 px).
        { text: 'Unreliable — some readings missing this hour', tone: 'warn' },
      ],
    });
  });

  it('suffixes the in-progress hour measurement with "so far"', () => {
    expect(buildUsageDayReadout({
      hourRange: '12:00–13:00',
      measuredKWh: 0.45,
      managedKWh: null,
      backgroundKWh: null,
      unreliable: false,
      inProgress: true,
    }).values).toEqual([{ text: nb('Measured 0.45 kWh so far') }]);
  });

  it('omits the split line when either half is missing', () => {
    expect(buildUsageDayReadout({
      hourRange: '13:00–14:00',
      measuredKWh: 1.31,
      managedKWh: null,
      backgroundKWh: null,
      unreliable: false,
    }).values).toEqual([{ text: nb('Measured 1.31 kWh') }]);
  });

  it('builds the usage day bucket range from the next bucket label, closing the day at 00:00', () => {
    const bucket = {
      label: '23:00',
      measuredKWh: 1.5,
      controlledKWh: null,
      uncontrolledKWh: null,
      unreliable: false,
    };
    expect(buildUsageDayBucketReadout(bucket, undefined).when).toBe('23:00–00:00');
    expect(buildUsageDayBucketReadout({ ...bucket, label: '13:00' }, '14:00').when).toBe('13:00–14:00');
  });

  it('passes the in-progress flag through the bucket readout builder', () => {
    const bucket = {
      label: '12:00',
      measuredKWh: 0.45,
      controlledKWh: null,
      uncontrolledKWh: null,
      unreliable: false,
    };
    expect(buildUsageDayBucketReadout(bucket, '13:00', true).values)
      .toEqual([{ text: nb('Measured 0.45 kWh so far') }]);
    expect(buildUsageDayBucketReadout(bucket, '13:00').values)
      .toEqual([{ text: nb('Measured 0.45 kWh') }]);
  });

  it('formats the power-week heatmap readout as day · hour range / total', () => {
    expect(buildPowerWeekReadout({
      dayLabel: 'Thu, Jun 4',
      hour: 13,
      kWh: 1.243,
      aggregated: false,
      unreliable: false,
    })).toEqual({
      when: 'Thu, Jun 4 · 13:00–14:00',
      values: [{ text: nb('1.24 kWh') }],
    });
  });

  it('keeps the aggregated-cell "kWh total" suffix on the heatmap readout', () => {
    expect(buildPowerWeekReadout({
      dayLabel: 'Sun, Oct 25',
      hour: 2,
      kWh: 2.4,
      aggregated: true,
      unreliable: false,
    }).values).toEqual([{ text: nb('2.40 kWh total') }]);
  });

  it('adds the unreliable consequence line to flagged heatmap cells', () => {
    expect(buildPowerWeekReadout({
      dayLabel: 'Thu, Jun 4',
      hour: 19,
      kWh: 0.92,
      aggregated: false,
      unreliable: true,
    }).values).toEqual([
      { text: nb('0.92 kWh') },
      // Same canonical consequence string as the usage-day readout — keeps
      // normal spaces so the prose stays wrappable at 320 px.
      { text: 'Unreliable — some readings missing this hour', tone: 'warn' },
    ]);
  });

  it('wraps the heatmap hour range across midnight', () => {
    expect(buildPowerWeekReadout({
      dayLabel: 'Thu, Jun 4',
      hour: 23,
      kWh: 0.5,
      aggregated: false,
      unreliable: false,
    }).when).toBe('Thu, Jun 4 · 23:00–00:00');
  });

  it('labels heatmap days from local-day midnight in negative-offset zones', () => {
    // 2026-06-04 is a Thursday. A UTC-midnight Date formatted in
    // America/New_York lands on Wednesday Jun 3 — the off-by-one the label
    // builder must avoid by resolving the instant via `getDateKeyStartMs`.
    const label = buildPowerWeekDayLabel('2026-06-04', 'America/New_York');
    expect(label).toMatch(/^Thu/);
    expect(label).toContain('4');
    expect(label).not.toContain('3');
  });

  it('formats the budget progress readout with the spec example figures', () => {
    expect(buildBudgetProgressReadout({
      endLabel: '14:00',
      budgetKWh: 8.4,
      actualKWh: 7.9,
      projectionKWh: 8.6,
    })).toEqual({
      when: 'By 14:00',
      values: [
        { text: `${nb('Budget 8.4 kWh')}${sep}${nb('Actual 7.9 kWh')}` },
        { text: nb('Projection 8.6 kWh') },
      ],
    });
  });

  it('formats the budget hourly readout with the spec example figures', () => {
    expect(buildBudgetHourlyReadout({
      hourRange: '13:00–14:00',
      budgetKWh: 0.92,
      managedKWh: 0.51,
      backgroundKWh: 0.41,
      price: { value: 0.84, unitLabel: 'kr/kWh' },
      actualKWh: 0.71,
    })).toEqual({
      when: '13:00–14:00',
      values: [
        { text: `${nb('Budget 0.92 kWh')} ${nb('(Managed 0.51')}${sep}${nb('Background 0.41)')}` },
        { text: nb('Price 0.84 kr/kWh') },
        { text: nb('Actual 0.71 kWh') },
      ],
    });
  });

  it('renders a bare price value when the payload supplies no price unit', () => {
    expect(buildBudgetHourlyReadout({
      hourRange: '13:00–14:00',
      budgetKWh: 0.92,
      managedKWh: null,
      backgroundKWh: null,
      price: { value: 0.84, unitLabel: null },
      actualKWh: null,
    }).values).toEqual([
      { text: nb('Budget 0.92 kWh') },
      { text: nb('Price 0.84') },
    ]);
  });

  it('renders tooltip HTML with one line per value and an encoded when-line', () => {
    const html = readoutToTooltipHtml({
      when: 'Thu 4 Jun <b>',
      values: [
        { text: '15.2 kWh' },
        { text: '1.2 kWh over budget', tone: 'warn' },
      ],
    }, { warnColor: '#f00' });
    expect(html).toBe('Thu 4 Jun &lt;b&gt;<br/>15.2 kWh<br/><span style="color:#f00;">1.2 kWh over budget</span>');
  });

  it('renders warn values as plain lines when no warn colour is supplied', () => {
    const html = readoutToTooltipHtml({
      when: '13:00–14:00',
      values: [{ text: 'Unreliable — some readings missing this hour', tone: 'warn' }],
    });
    expect(html).toBe('13:00–14:00<br/>Unreliable — some readings missing this hour');
  });
});

describe('resolveTooltipDataIndex', () => {
  it('resolves the data index from single-object and array params', () => {
    expect(resolveTooltipDataIndex({ dataIndex: 5 })).toBe(5);
    expect(resolveTooltipDataIndex([{ dataIndex: 3 }, { dataIndex: 9 }])).toBe(3);
  });

  it('rejects missing, non-numeric, and non-finite data indexes', () => {
    expect(resolveTooltipDataIndex(undefined)).toBe(-1);
    expect(resolveTooltipDataIndex({})).toBe(-1);
    expect(resolveTooltipDataIndex({ dataIndex: '4' })).toBe(-1);
    // NaN/Infinity pass a bare typeof check but defeat the callers'
    // `index < 0 || index >= length` range guard — must resolve to -1.
    expect(resolveTooltipDataIndex({ dataIndex: Number.NaN })).toBe(-1);
    expect(resolveTooltipDataIndex({ dataIndex: Number.POSITIVE_INFINITY })).toBe(-1);
  });
});

describe('resolveGridCellFromPixel', () => {
  const gridChart = (raw: unknown, contains = true): EChartsType => ({
    containPixel: () => contains,
    convertFromPixel: () => raw,
  } as unknown as EChartsType);

  it('rounds the grid finder result to a cell coordinate', () => {
    expect(resolveGridCellFromPixel(gridChart([2.4, 13.6]), 10, 10))
      .toEqual({ columnIndex: 2, rowIndex: 14 });
  });

  it('returns null outside the grid', () => {
    expect(resolveGridCellFromPixel(gridChart([2, 13], false), 10, 10)).toBeNull();
  });

  it('returns null for scalar or non-finite finder results', () => {
    expect(resolveGridCellFromPixel(gridChart(5), 10, 10)).toBeNull();
    expect(resolveGridCellFromPixel(gridChart(null), 10, 10)).toBeNull();
    expect(resolveGridCellFromPixel(gridChart([Number.NaN, 3]), 10, 10)).toBeNull();
    expect(resolveGridCellFromPixel(gridChart([3, Number.POSITIVE_INFINITY]), 10, 10)).toBeNull();
  });
});

type FakeChart = {
  chart: EChartsType;
  actions: Array<Record<string, unknown>>;
  tap: (x: number, y: number) => void;
  setContainsPixel: (value: boolean) => void;
  setPixelIndex: (value: number | null) => void;
};

// Scripted chart double for the readout primitive: captures the zr click
// handler, records `dispatchAction` payloads, and lets the test script the
// pixel→index resolution (`containPixel` + `convertFromPixel`).
const createFakeChart = (): FakeChart => {
  const actions: Array<Record<string, unknown>> = [];
  let clickHandler: ((event: { offsetX: number; offsetY: number }) => void) | null = null;
  let containsPixel = true;
  let pixelIndex: number | null = null;
  const chart = {
    setOption: () => {},
    resize: () => {},
    dispose: () => {},
    isDisposed: () => false,
    convertFromPixel: () => pixelIndex,
    containPixel: () => containsPixel,
    dispatchAction: (payload: Record<string, unknown>) => {
      actions.push(payload);
    },
    getZr: () => ({
      on: (event: string, handler: (event: { offsetX: number; offsetY: number }) => void) => {
        if (event === 'click') clickHandler = handler;
      },
    }),
  } as unknown as EChartsType;
  return {
    chart,
    actions,
    tap: (x, y) => clickHandler?.({ offsetX: x, offsetY: y }),
    setContainsPixel: (value) => {
      containsPixel = value;
    },
    setPixelIndex: (value) => {
      pixelIndex = value;
    },
  };
};

const contentFor = (index: number) => ({
  when: `hour ${index}`,
  values: [{ text: `value ${index}` }],
});

describe('attachChartReadout', () => {
  it('renders the default selection on update and dispatches the select action', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({ itemCount: 24, defaultIndex: 7, resolveContent: contentFor });

    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 7');
    expect(host.querySelector('.chart-readout__secondary')?.textContent).toBe('value 7');
    const select = fake.actions.find((action) => action.type === 'select');
    expect(select).toMatchObject({ type: 'select', seriesIndex: 0, dataIndex: 7 });
  });

  it('selects the tapped column and updates the readout', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({ itemCount: 24, defaultIndex: 7, resolveContent: contentFor });

    fake.setPixelIndex(13);
    fake.tap(100, 50);

    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 13');
    const selects = fake.actions.filter((action) => action.type === 'select');
    expect(selects[selects.length - 1]).toMatchObject({ dataIndex: 13 });
  });

  it('restores the default selection on a tap outside the plot grid', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({ itemCount: 24, defaultIndex: 7, resolveContent: contentFor });

    fake.setPixelIndex(13);
    fake.tap(100, 50);
    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 13');

    fake.setContainsPixel(false);
    fake.tap(2, 2);
    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 7');
  });

  it('re-applies an explicit selection after a notMerge refresh', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({ itemCount: 24, defaultIndex: 7, resolveContent: contentFor });

    fake.setPixelIndex(13);
    fake.tap(100, 50);
    fake.actions.length = 0;

    // Realtime refresh: the chart module calls `update` again after
    // `setOption(notMerge: true)` wiped ECharts' select state.
    handle.update({ itemCount: 24, defaultIndex: 7, resolveContent: contentFor });

    const selects = fake.actions.filter((action) => action.type === 'select');
    expect(selects[selects.length - 1]).toMatchObject({ dataIndex: 13 });
    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 13');
  });

  it('drops a stale explicit selection when the data shrinks below it', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({ itemCount: 24, defaultIndex: 3, resolveContent: contentFor });

    fake.setPixelIndex(20);
    fake.tap(100, 50);
    handle.update({ itemCount: 5, defaultIndex: 3, resolveContent: contentFor });

    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 3');
  });

  it('marks warn-toned values with the warn class', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({
      itemCount: 1,
      defaultIndex: 0,
      resolveContent: () => ({
        when: 'Wed, Jun 4',
        values: [
          { text: '15.2 kWh' },
          { text: '1.2 kWh over budget', tone: 'warn' as const },
        ],
      }),
    });

    const warn = host.querySelector('.chart-readout__value--warn');
    expect(warn?.textContent).toBe('1.2 kWh over budget');
    // The separator's NBSP glues the `·` to the FOLLOWING segment so a
    // wrapped line leads with the dot instead of stranding it at a line end.
    expect(host.querySelector('.chart-readout__secondary')?.textContent)
      .toBe('15.2 kWh ·\u00A01.2 kWh over budget');
  });

  it('skips the native select/unselect dispatch when selectSeriesIndexes is empty', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({
      itemCount: 24,
      defaultIndex: 7,
      resolveContent: contentFor,
      selectSeriesIndexes: [],
    });

    // Marker-carrying line charts pass `[]`: the readout still renders, but
    // no native select state is touched (the marker series owns the visual).
    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 7');
    expect(fake.actions.filter((action) => action.type === 'select' || action.type === 'unselect'))
      .toEqual([]);
  });

  it('routes taps through a custom pixel resolver when one is supplied', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    // The 1D fallback would resolve to 13 — the override must win.
    fake.setPixelIndex(13);
    handle.update({
      itemCount: 24,
      defaultIndex: 7,
      resolveContent: contentFor,
      resolveIndexFromPixel: (x) => (x === 100 ? 5 : null),
    });

    fake.tap(100, 50);
    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 5');

    // Resolver returns null (empty cell / outside grid): restore the default.
    fake.tap(3, 3);
    expect(host.querySelector('.chart-readout__primary')?.textContent).toBe('hour 7');
  });

  it('clears the host and ignores taps after detach', () => {
    const fake = createFakeChart();
    const host = document.createElement('div');
    const handle = attachChartReadout({ chart: fake.chart, host });
    handle.update({ itemCount: 24, defaultIndex: 7, resolveContent: contentFor });
    handle.detach();

    expect(host.childElementCount).toBe(0);
    fake.actions.length = 0;
    fake.setPixelIndex(2);
    fake.tap(10, 10);
    expect(fake.actions).toEqual([]);
    expect(host.childElementCount).toBe(0);
  });
});
