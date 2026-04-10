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
    <div id="hourly-pattern"></div>
    <div id="hourly-pattern-meta"></div>
    <h4 id="usage-day-title"></h4>
    <div id="usage-day-label"></div>
    <div id="usage-day-status-pill" hidden></div>
    <div id="usage-day-toggle-mount"></div>
    <div id="usage-day-total"></div>
    <div id="usage-day-peak"></div>
    <div id="usage-day-over-cap"></div>
    <div id="usage-day-chart"><div id="usage-day-bars"></div><div id="usage-day-labels"></div></div>
    <div id="usage-day-empty"></div>
    <div id="usage-day-meta"></div>
  `;
};

const installHomeyClient = async (tracker: unknown, timeZone = 'UTC') => {
  const { setHomeyClient } = await import('../src/ui/homey.ts');
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
    api: (method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (!callback) return;
      if (method === 'GET' && uri === '/ui_power') {
        callback(null, { tracker, status: null, heartbeat: null });
        return;
      }
      callback(null, null);
    },
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
    vi.resetModules();
    buildPowerDom();
  });

  it('computes weekday/weekend averages from buckets when dailyTotals are missing', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 7 * 24, 1.2);
    await installHomeyClient({ buckets });

    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    const weekdayEl = document.querySelector('#usage-weekday-avg') as HTMLElement;
    const weekendEl = document.querySelector('#usage-weekend-avg') as HTMLElement;
    expect(weekdayEl.textContent).not.toBe('Not enough data');
    expect(weekendEl.textContent).not.toBe('Not enough data');
  });

  it('renders hourly pattern chart with echarts when hourlyAverages are missing', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 24, 1.2);
    await installHomeyClient({ buckets });

    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    const chartRoot = document.querySelector('#hourly-pattern') as HTMLElement | null;
    expect(chartRoot).not.toBeNull();
    expect(chartRoot?.querySelector('svg')).not.toBeNull();
    expect(chartRoot?.querySelector('.usage-row--pattern')).toBeNull();
  });

  it('renders daily history chart from buckets when dailyTotals are missing', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 5 * 24, 0.6);
    await installHomeyClient({ buckets });

    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    const chartRoot = document.querySelector('#daily-list') as HTMLElement | null;
    expect(chartRoot).not.toBeNull();
    expect(chartRoot?.querySelector('svg')).not.toBeNull();
    expect(chartRoot?.querySelector('.usage-row--daily')).toBeNull();
  });

  it('limits hourly detail to the current UTC week by default', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 14 * 24, 0.4);
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2025, 0, 10, 12, 0, 0));
    const { renderPowerUsage } = await import('../src/ui/power.ts');
    const entries = Object.entries(buckets).map(([iso, kWh]) => ({ hour: new Date(iso), kWh }));
    renderPowerUsage(entries);
    const powerList = document.querySelector('#power-list') as HTMLElement;
    expect(powerList.querySelector('svg')).not.toBeNull();
    vi.restoreAllMocks();
  });

  it('renders heatmap chart when hourly budget is present', async () => {
    const buckets = buildBuckets('2025-01-13T00:00:00.000Z', 2, 1.2);
    const hourlyBudgets = Object.fromEntries(Object.keys(buckets).map((iso) => [iso, 1.0]));
    // Jan 15 (Wednesday) — current week (Jan 13–19) contains the Jan 13 bucket data
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2025, 0, 15, 12, 0, 0));
    const { renderPowerUsage } = await import('../src/ui/power.ts');
    const entries = Object.entries(buckets).map(([iso, kWh]) => ({
      hour: new Date(iso),
      kWh,
      budgetKWh: hourlyBudgets[iso],
    }));
    renderPowerUsage(entries);
    const powerList = document.querySelector('#power-list') as HTMLElement;
    expect(powerList.querySelector('svg')).not.toBeNull();
    expect(powerList.style.height).toBe('240px');
    vi.restoreAllMocks();
  });

  it('maps controlled and uncontrolled split from tracker buckets', async () => {
    const iso = '2025-01-06T00:00:00.000Z';
    await installHomeyClient({
      buckets: { [iso]: 2.5 },
      controlledBuckets: { [iso]: 1.1 },
    });

    const { getPowerUsage } = await import('../src/ui/power.ts');
    const entries = await getPowerUsage();

    expect(entries.length).toBe(1);
    expect(entries[0].kWh).toBeCloseTo(2.5, 6);
    expect(entries[0].controlledKWh).toBeCloseTo(1.1, 6);
    expect(entries[0].uncontrolledKWh).toBeCloseTo(1.4, 6);
  });

  it('preserves zero-valued usage buckets as measured data', async () => {
    const iso = '2025-01-06T00:00:00.000Z';
    await installHomeyClient({
      buckets: { [iso]: 0 },
      hourlySampleCounts: { [iso]: 3 },
    });

    const { getPowerUsage } = await import('../src/ui/power.ts');
    const entries = await getPowerUsage();

    expect(entries).toHaveLength(1);
    expect(entries[0].hour.toISOString()).toBe(iso);
    expect(entries[0].kWh).toBe(0);
    expect(entries[0].unreliable).toBe(false);
  });

  it('keeps a cross-hour outage unreliable when the hour only has a single zero sample', async () => {
    const iso = '2025-01-06T08:00:00.000Z';
    await installHomeyClient({
      buckets: { [iso]: 0 },
      hourlySampleCounts: { [iso]: 1 },
      unreliablePeriods: [{
        start: Date.parse('2025-01-06T07:59:00.000Z'),
        end: Date.parse('2025-01-06T08:01:00.000Z'),
      }],
    });

    const { getPowerUsage } = await import('../src/ui/power.ts');
    const entries = await getPowerUsage();

    expect(entries).toHaveLength(1);
    expect(entries[0].unreliable).toBe(true);
  });

  it('treats repeated zero samples in an unreliable hour as valid measured data', async () => {
    const iso = '2025-01-06T08:00:00.000Z';
    await installHomeyClient({
      buckets: { [iso]: 0 },
      hourlySampleCounts: { [iso]: 6 },
      unreliablePeriods: [{
        start: Date.parse('2025-01-06T07:59:00.000Z'),
        end: Date.parse('2025-01-06T08:01:00.000Z'),
      }],
    });

    const { getPowerUsage } = await import('../src/ui/power.ts');
    const entries = await getPowerUsage();

    expect(entries).toHaveLength(1);
    expect(entries[0].unreliable).toBe(false);
  });

  it('keeps repeated non-zero samples unreliable when the hour overlaps an outage', async () => {
    const iso = '2025-01-06T08:00:00.000Z';
    await installHomeyClient({
      buckets: { [iso]: 1.2 },
      hourlySampleCounts: { [iso]: 6 },
      unreliablePeriods: [{
        start: Date.parse('2025-01-06T07:59:00.000Z'),
        end: Date.parse('2025-01-06T08:01:00.000Z'),
      }],
    });

    const { getPowerUsage } = await import('../src/ui/power.ts');
    const entries = await getPowerUsage();

    expect(entries).toHaveLength(1);
    expect(entries[0].unreliable).toBe(true);
  });

  it('renders the usage day chart with echarts when split usage is available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    await installHomeyClient({}, 'UTC');
    const { renderUsageDayView } = await import('../src/ui/usageDayView.ts');

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
    vi.useRealTimers();
  });

  it('renders a single bar series in usage day echarts', async () => {
    const setOption = vi.fn();
    const initEcharts = vi.fn(() => ({
      setOption,
      resize: vi.fn(),
      dispose: vi.fn(),
    }));
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));
    const { renderUsageDayChartEcharts } = await import('../src/ui/usageDayChartEcharts.ts');
    const barsEl = document.querySelector('#usage-day-bars') as HTMLElement;
    const labelsEl = document.querySelector('#usage-day-labels') as HTMLElement;

    const rendered = renderUsageDayChartEcharts({
      bars: [
        { label: '00:00', value: 1.2 },
        { label: '01:00', value: 0.4 },
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
    const option = setOption.mock.calls[0][0] as { series?: Array<{ type?: string }> };
    const barSeries = option.series?.find((series) => series.type === 'bar');
    expect(barSeries).toBeDefined();
    expect(option.series?.find((series) => series.type === 'scatter')).toBeUndefined();
  });

  it('clears stale usage day chart DOM when bars are empty', async () => {
    const dispose = vi.fn();
    const initEcharts = vi.fn(() => ({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose,
    }));
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));
    const { renderUsageDayChartEcharts } = await import('../src/ui/usageDayChartEcharts.ts');
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

  it('hides usage day labels when echarts rendering fails', async () => {
    const dispose = vi.fn();
    const initEcharts = vi.fn(() => ({
      setOption: vi.fn(() => {
        throw new Error('render failed');
      }),
      resize: vi.fn(),
      dispose,
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));
    const { renderUsageDayChartEcharts } = await import('../src/ui/usageDayChartEcharts.ts');
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

  it('includes measured value in usage day tooltip text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    await installHomeyClient({}, 'UTC');
    let capturedBars: Array<{ title: string; marker?: { value: number } }> = [];
    const renderUsageDayChartEcharts = vi.fn((params: { bars: Array<{ title: string; marker?: { value: number } }> }) => {
      capturedBars = params.bars;
      return true;
    });
    vi.doMock('../src/ui/usageDayChartEcharts.ts', () => ({ renderUsageDayChartEcharts }));
    const { renderUsageDayView } = await import('../src/ui/usageDayView.ts');

    renderUsageDayView([{
      hour: new Date('2025-01-06T00:00:00.000Z'),
      kWh: 2.5,
      budgetKWh: 2.0,
    }]);

    expect(capturedBars[0]?.title).toContain('Measured 2.50 kWh');
    expect(capturedBars[0]?.marker).toBeUndefined();
    vi.useRealTimers();
  });

  it('renders consecutive zero-usage hours as valid data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    await installHomeyClient({}, 'UTC');
    const { renderUsageDayView } = await import('../src/ui/usageDayView.ts');

    renderUsageDayView([
      { hour: new Date('2025-01-06T00:00:00.000Z'), kWh: 0 },
      { hour: new Date('2025-01-06T01:00:00.000Z'), kWh: 0 },
      { hour: new Date('2025-01-06T02:00:00.000Z'), kWh: 0 },
    ]);

    const empty = document.querySelector('#usage-day-empty') as HTMLElement;
    const status = document.querySelector('#usage-day-status-pill') as HTMLElement;
    const total = document.querySelector('#usage-day-total') as HTMLElement;

    expect(empty.hidden).toBe(true);
    expect(status.hidden).toBe(true);
    expect(total.textContent).toBe('0.0 kWh');
    vi.useRealTimers();
  });

  it('matches daily budget today usage with the power summary total', async () => {
    const { buildDayContext } = await import('../../shared-domain/src/dailyBudget/dayContext.ts');
    const { getDateKeyInTimeZone, getDateKeyStartMs } = await import('../../shared-domain/src/utils/dateUtils.ts');
    const { getPowerStats } = await import('../src/ui/power.ts');

    const timeZone = 'Europe/Oslo';
    const nowMs = Date.UTC(2025, 0, 15, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowMs));

    const dateKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
    const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
    const buckets = buildBuckets(new Date(dayStartMs).toISOString(), 6, 1.25);
    await installHomeyClient({ buckets }, timeZone);

    const context = buildDayContext({ nowMs, timeZone, powerTracker: { buckets } });
    const { stats } = await getPowerStats();

    expect(stats.today).toBeCloseTo(context.usedNowKWh, 6);
    vi.useRealTimers();
  });
});
