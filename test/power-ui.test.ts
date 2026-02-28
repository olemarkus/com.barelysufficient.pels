const buildPowerDom = () => {
  document.body.innerHTML = `
    <div id="power-list"></div>
    <div id="power-empty"></div>
    <button id="power-week-prev"></button>
    <div id="power-week-label"></div>
    <button id="power-week-next"></button>
    <div id="daily-list"></div>
    <div id="daily-empty"></div>
    <div id="usage-today"></div>
    <div id="usage-week"></div>
    <div id="usage-month"></div>
    <div id="usage-weekday-avg"></div>
    <div id="usage-weekend-avg"></div>
    <button id="hourly-pattern-toggle-all"></button>
    <button id="hourly-pattern-toggle-weekday"></button>
    <button id="hourly-pattern-toggle-weekend"></button>
    <div id="hourly-pattern"></div>
    <div id="hourly-pattern-meta"></div>
    <button id="daily-history-range-7"></button>
    <button id="daily-history-range-14"></button>
    <h4 id="usage-day-title"></h4>
    <div id="usage-day-label"></div>
    <div id="usage-day-status-pill"></div>
    <button id="usage-day-toggle-yesterday"></button>
    <button id="usage-day-toggle-today"></button>
    <div id="usage-day-total"></div>
    <div id="usage-day-peak"></div>
    <div id="usage-day-over-cap"></div>
    <div id="usage-day-chart"><div id="usage-day-bars"></div><div id="usage-day-labels"></div></div>
    <div id="usage-day-empty"></div>
    <div id="usage-day-meta"></div>
  `;
};

const installHomeyClient = (tracker: unknown, timeZone = 'UTC') => {
  const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
  setHomeyClient({
    ready: async () => { },
    get: (key, cb) => {
      if (key === 'power_tracker_state') {
        cb(null, tracker);
        return;
      }
      cb(null, null);
    },
    set: (_key, _value, cb) => cb(null),
    on: () => { },
    clock: {
      getTimezone: () => timeZone,
    },
  });
};

const buildBuckets = (startIso: string, hours: number, kWh: number) => {
  const buckets: Record<string, number> = {};
  const start = new Date(startIso).getTime();
  for (let i = 0; i < hours; i += 1) {
    const ts = start + i * 60 * 60 * 1000;
    buckets[new Date(ts).toISOString()] = kWh;
  }
  return buckets;
};

describe('power page stats (buckets-only)', () => {
  beforeEach(() => {
    jest.resetModules();
    buildPowerDom();
  });

  it('computes weekday/weekend averages from buckets when dailyTotals are missing', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 7 * 24, 1.2);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const weekdayEl = document.querySelector('#usage-weekday-avg') as HTMLElement;
    const weekendEl = document.querySelector('#usage-weekend-avg') as HTMLElement;
    expect(weekdayEl.textContent).not.toBe('Not enough data');
    expect(weekendEl.textContent).not.toBe('Not enough data');
  });

  it('renders hourly pattern chart with echarts when hourlyAverages are missing', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 24, 1.2);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const chartRoot = document.querySelector('#hourly-pattern') as HTMLElement | null;
    expect(chartRoot).not.toBeNull();
    expect(chartRoot?.querySelector('svg')).not.toBeNull();
    expect(chartRoot?.querySelector('.usage-row--pattern')).toBeNull();
  });

  it('renders daily history chart from buckets when dailyTotals are missing', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 5 * 24, 0.6);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const chartRoot = document.querySelector('#daily-list') as HTMLElement | null;
    expect(chartRoot).not.toBeNull();
    expect(chartRoot?.querySelector('svg')).not.toBeNull();
    expect(chartRoot?.querySelector('.usage-row--daily')).toBeNull();
  });

  it('switches hourly pattern chart view with segmented toggles', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 14 * 24, 0.6);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const allButton = document.querySelector('#hourly-pattern-toggle-all') as HTMLButtonElement;
    const weekdayButton = document.querySelector('#hourly-pattern-toggle-weekday') as HTMLButtonElement;
    const weekendButton = document.querySelector('#hourly-pattern-toggle-weekend') as HTMLButtonElement;
    expect(allButton.classList.contains('is-active')).toBe(true);

    weekdayButton.click();
    expect(weekdayButton.classList.contains('is-active')).toBe(true);
    expect(allButton.classList.contains('is-active')).toBe(false);

    weekendButton.click();
    expect(weekendButton.classList.contains('is-active')).toBe(true);
    expect(weekdayButton.classList.contains('is-active')).toBe(false);

    const chartRoot = document.querySelector('#hourly-pattern') as HTMLElement;
    expect(chartRoot.querySelector('svg')).not.toBeNull();
  });

  it('switches daily history chart range with segmented toggles', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 20 * 24, 0.6);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const sevenDaysButton = document.querySelector('#daily-history-range-7') as HTMLButtonElement;
    const fourteenDaysButton = document.querySelector('#daily-history-range-14') as HTMLButtonElement;
    expect(fourteenDaysButton.classList.contains('is-active')).toBe(true);

    sevenDaysButton.click();
    expect(sevenDaysButton.classList.contains('is-active')).toBe(true);
    expect(fourteenDaysButton.classList.contains('is-active')).toBe(false);

    const chartRoot = document.querySelector('#daily-list') as HTMLElement;
    expect(chartRoot.querySelector('svg')).not.toBeNull();
  });

  it('limits hourly detail to the current UTC week by default', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 14 * 24, 0.4);
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2025, 0, 10, 12, 0, 0));
    const { renderPowerUsage } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    const entries = Object.entries(buckets).map(([iso, kWh]) => ({ hour: new Date(iso), kWh }));
    renderPowerUsage(entries);
    const rows = document.querySelectorAll('.usage-row--detail');
    expect(rows.length).toBe(7 * 24);
    jest.restoreAllMocks();
  });

  it('shows budget detail on the usage bar when hourly budget is present', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 2, 1.2);
    const hourlyBudgets = Object.fromEntries(Object.keys(buckets).map((iso) => [iso, 1.0]));
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2025, 0, 6, 12, 0, 0));
    const { renderPowerUsage } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    const entries = Object.entries(buckets).map(([iso, kWh]) => ({
      hour: new Date(iso),
      kWh,
      budgetKWh: hourlyBudgets[iso],
    }));
    renderPowerUsage(entries);
    const labels = document.querySelectorAll('.power-meter .usage-bar__label');
    expect(labels.length).toBeGreaterThan(0);
    const titled = document.querySelectorAll('.power-meter[data-tooltip*="budget"]');
    expect(titled.length).toBeGreaterThan(0);
    jest.restoreAllMocks();
  });

  it('maps controlled and uncontrolled split from tracker buckets', async () => {
    const iso = '2025-01-06T00:00:00.000Z';
    installHomeyClient({
      buckets: { [iso]: 2.5 },
      controlledBuckets: { [iso]: 1.1 },
    });

    const { getPowerUsage } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    const entries = await getPowerUsage();

    expect(entries.length).toBe(1);
    expect(entries[0].kWh).toBeCloseTo(2.5, 6);
    expect(entries[0].controlledKWh).toBeCloseTo(1.1, 6);
    expect(entries[0].uncontrolledKWh).toBeCloseTo(1.4, 6);
  });

  it('renders the usage day chart with echarts when split usage is available', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    installHomeyClient({}, 'UTC');
    const { renderUsageDayView } = require('../settings/src/ui/usageDayView') as typeof import('../settings/src/ui/usageDayView');

    renderUsageDayView([{
      hour: new Date('2025-01-06T00:00:00.000Z'),
      kWh: 2.5,
      controlledKWh: 1.1,
      uncontrolledKWh: 1.4,
      budgetKWh: 3,
    }]);

    const chartRoot = document.querySelector('#usage-day-bars') as HTMLElement | null;
    expect(chartRoot).not.toBeNull();
    expect(chartRoot?.classList.contains('usage-day-bars--echarts')).toBe(true);
    expect(chartRoot?.querySelector('svg')).not.toBeNull();
    expect(document.querySelector('.day-view-bar')).toBeNull();
    jest.useRealTimers();
  });

  it('renders hourly budget markers as a scatter series in usage day echarts', () => {
    const setOption = jest.fn();
    const initEcharts = jest.fn(() => ({
      setOption,
      resize: jest.fn(),
      dispose: jest.fn(),
    }));
    jest.doMock('../settings/src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));
    const { renderUsageDayChartEcharts } = require('../settings/src/ui/usageDayChartEcharts') as typeof import('../settings/src/ui/usageDayChartEcharts');
    const barsEl = document.querySelector('#usage-day-bars') as HTMLElement;
    const labelsEl = document.querySelector('#usage-day-labels') as HTMLElement;

    const rendered = renderUsageDayChartEcharts({
      bars: [
        {
          label: '00:00',
          value: 1.2,
          marker: { value: 0.9, className: 'day-view-marker--budget' },
        },
        {
          label: '01:00',
          value: 0.4,
        },
      ],
      labels: ['00:00', '01:00'],
      currentBucketIndex: 0,
      enabled: true,
      barsEl,
      labelsEl,
    });

    expect(rendered).toBe(true);
    expect(initEcharts).toHaveBeenCalledWith(
      barsEl,
      undefined,
      expect.objectContaining({ renderer: 'svg', width: 480, height: 160 }),
    );
    expect(setOption).toHaveBeenCalledTimes(1);
    const option = setOption.mock.calls[0][0] as { series?: Array<{ type?: string; data?: Array<number | null> }> };
    const markerSeries = option.series?.find((series) => series.type === 'scatter');
    expect(markerSeries).toBeDefined();
    expect(markerSeries?.data).toEqual([0.9, null]);
  });

  it('clears stale usage day chart DOM when bars are empty', () => {
    const dispose = jest.fn();
    const initEcharts = jest.fn(() => ({
      setOption: jest.fn(),
      resize: jest.fn(),
      dispose,
    }));
    jest.doMock('../settings/src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));
    const { renderUsageDayChartEcharts } = require('../settings/src/ui/usageDayChartEcharts') as typeof import('../settings/src/ui/usageDayChartEcharts');
    const barsEl = document.querySelector('#usage-day-bars') as HTMLElement;
    const labelsEl = document.querySelector('#usage-day-labels') as HTMLElement;

    const rendered = renderUsageDayChartEcharts({
      bars: [{ label: '00:00', value: 0.8 }],
      labels: ['00:00'],
      currentBucketIndex: 0,
      enabled: true,
      barsEl,
      labelsEl,
    });

    expect(rendered).toBe(true);
    barsEl.innerHTML = '<svg><g></g></svg>';

    const renderedEmpty = renderUsageDayChartEcharts({
      bars: [],
      labels: [],
      currentBucketIndex: -1,
      enabled: true,
      barsEl,
      labelsEl,
    });

    expect(renderedEmpty).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(barsEl.childElementCount).toBe(0);
    expect(labelsEl.hidden).toBe(true);
  });

  it('hides usage day labels when echarts rendering fails', () => {
    const dispose = jest.fn();
    const initEcharts = jest.fn(() => ({
      setOption: jest.fn(() => {
        throw new Error('render failed');
      }),
      resize: jest.fn(),
      dispose,
    }));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.doMock('../settings/src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));
    const { renderUsageDayChartEcharts } = require('../settings/src/ui/usageDayChartEcharts') as typeof import('../settings/src/ui/usageDayChartEcharts');
    const barsEl = document.querySelector('#usage-day-bars') as HTMLElement;
    const labelsEl = document.querySelector('#usage-day-labels') as HTMLElement;

    try {
      const rendered = renderUsageDayChartEcharts({
        bars: [{ label: '00:00', value: 0.8 }],
        labels: ['00:00'],
        currentBucketIndex: 0,
        enabled: true,
        barsEl,
        labelsEl,
      });

      expect(rendered).toBe(false);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(barsEl.childElementCount).toBe(0);
      expect(labelsEl.hidden).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('includes budget and exceedance details in usage day tooltip text', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    installHomeyClient({}, 'UTC');
    let capturedBars: Array<{ title: string; marker?: { value: number } }> = [];
    const renderUsageDayChartEcharts = jest.fn((params: { bars: Array<{ title: string; marker?: { value: number } }> }) => {
      capturedBars = params.bars;
      return true;
    });
    jest.doMock('../settings/src/ui/usageDayChartEcharts', () => ({ renderUsageDayChartEcharts }));
    const { renderUsageDayView } = require('../settings/src/ui/usageDayView') as typeof import('../settings/src/ui/usageDayView');

    renderUsageDayView([{
      hour: new Date('2025-01-06T00:00:00.000Z'),
      kWh: 2.5,
      budgetKWh: 2.0,
    }]);

    expect(capturedBars[0]?.title).toContain('Budget 2.00 kWh');
    expect(capturedBars[0]?.title).toContain('exceeded by 0.50 kWh');
    expect(capturedBars[0]?.marker?.value).toBeCloseTo(2.0, 6);
    jest.useRealTimers();
  });

  it('matches daily budget today usage with the power summary total', async () => {
    const { buildDayContext } = require('../lib/dailyBudget/dailyBudgetState') as typeof import('../lib/dailyBudget/dailyBudgetState');
    const { getDateKeyInTimeZone, getDateKeyStartMs } = require('../lib/utils/dateUtils') as typeof import('../lib/utils/dateUtils');
    const { getPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');

    const timeZone = 'Europe/Oslo';
    const nowMs = Date.UTC(2025, 0, 15, 12, 0, 0);
    jest.useFakeTimers();
    jest.setSystemTime(new Date(nowMs));

    const dateKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
    const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
    const buckets = buildBuckets(new Date(dayStartMs).toISOString(), 6, 1.25);
    installHomeyClient({ buckets }, timeZone);

    const context = buildDayContext({ nowMs, timeZone, powerTracker: { buckets } });
    const { stats } = await getPowerStats();

    expect(stats.today).toBeCloseTo(context.usedNowKWh, 6);
    jest.useRealTimers();
  });
});
