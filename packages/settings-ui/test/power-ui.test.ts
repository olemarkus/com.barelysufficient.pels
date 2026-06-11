const buildPowerDom = () => {
  document.body.innerHTML = `
    <div id="power-list" class="power-week-chart"></div>
    <div id="power-empty"></div>
    <button id="power-week-prev"></button>
    <div id="power-week-label"></div>
    <button id="power-week-next"></button>
    <div id="daily-list"></div>
    <div id="daily-empty"></div>
    <div id="usage-today"></div>
    <div id="usage-week"></div>
    <div id="usage-month"></div>
    <div id="usage-pattern-averages">
      <div data-pattern-metric="weekday">
        <span id="usage-weekday-avg"></span>
      </div>
      <div data-pattern-metric="weekend">
        <span id="usage-weekend-avg"></span>
      </div>
    </div>
    <div id="hourly-pattern-toggle-mount"></div>
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
    <div id="usage-day-readout" hidden></div>
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

// Several tests below fake the system clock. Restore real timers after every
// test at file scope so a throwing assertion mid-test cannot leak faked timers
// into later tests (useRealTimers is a no-op when timers aren't faked).
afterEach(() => {
  vi.useRealTimers();
});

describe('power page stats (buckets-only)', () => {
  beforeEach(() => {
    vi.resetModules();
    buildPowerDom();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  // Regression: TODO 585. The Typical-day Weekdays / Weekend segmented control
  // must hide the non-selected metric from the stat strip so the strip
  // reinforces which segment is active.
  it('hides the weekend stat when Weekdays segment is selected', async () => {
    // Use a 14-day window so weekday + weekend buckets both have data.
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 14 * 24, 1.2);
    await installHomeyClient({ buckets });

    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    const weekdayMetric = document.querySelector<HTMLElement>('[data-pattern-metric="weekday"]');
    const weekendMetric = document.querySelector<HTMLElement>('[data-pattern-metric="weekend"]');
    expect(weekdayMetric?.hidden).toBe(false);
    expect(weekendMetric?.hidden).toBe(false);

    // Click the Weekdays segmented option.
    const weekdayBtn = Array.from(document.querySelectorAll('button.segmented__option'))
      .find((btn) => btn.textContent === 'Weekdays') as HTMLButtonElement | undefined;
    expect(weekdayBtn).toBeDefined();
    weekdayBtn?.click();

    expect(weekdayMetric?.hidden).toBe(false);
    expect(weekendMetric?.hidden).toBe(true);

    // Switch to Weekend.
    const weekendBtn = Array.from(document.querySelectorAll('button.segmented__option'))
      .find((btn) => btn.textContent === 'Weekend') as HTMLButtonElement | undefined;
    weekendBtn?.click();

    expect(weekdayMetric?.hidden).toBe(true);
    expect(weekendMetric?.hidden).toBe(false);

    // Switch back to All days.
    const allBtn = Array.from(document.querySelectorAll('button.segmented__option'))
      .find((btn) => btn.textContent === 'All days') as HTMLButtonElement | undefined;
    allBtn?.click();

    expect(weekdayMetric?.hidden).toBe(false);
    expect(weekendMetric?.hidden).toBe(false);
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

  // Regression: `aggregateAndPruneHistory` in `lib/power/tracker.ts` only
  // moves buckets older than 30 days into `dailyTotals`. When both maps are
  // populated, the Daily-usage chart used to read from `dailyTotals` alone,
  // making it show the 14 days right before the 30-day cliff (e.g. 3–15 Apr on
  // 16 May). The merge in `getPowerStats` must fold recent bucket-derived days
  // into the chart so the window advances forward to "today − 1".
  it('advances daily history window past stale dailyTotals using recent buckets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 16, 12, 0, 0))); // 2026-05-16 12:00 UTC

    // Stale persisted dailyTotals: 14 days ending 15 Apr (just before the 30-day cliff).
    const dailyTotals: Record<string, number> = {};
    const staleStart = Date.UTC(2026, 3, 2); // 2 Apr
    for (let i = 0; i < 14; i += 1) {
      const ts = staleStart + i * 24 * 60 * 60 * 1000;
      dailyTotals[`${new Date(ts).toISOString().slice(0, 10)}`] = 60 + i;
    }

    // Recent buckets: full hourly samples for 17 Apr through 16 May (today).
    const buckets = buildBuckets('2026-04-17T00:00:00.000Z', 30 * 24, 1.5);

    await installHomeyClient({ dailyTotals, buckets });

    const { getPowerStats } = await import('../src/ui/power.ts');
    const { stats } = await getPowerStats();

    // The chart slices to DAILY_HISTORY_DAYS = 14 newest entries excluding today.
    const dates = stats.dailyHistory.map((point) => point.date);
    expect(dates.length).toBe(14);
    expect(dates[0]).toBe('2026-05-15'); // today − 1, sorted newest first
    expect(dates[dates.length - 1]).toBe('2026-05-02'); // today − 14
    // The Apr-only window must not survive when recent bucket data is present.
    for (const date of dates) {
      expect(date.startsWith('2026-04')).toBe(false);
    }
    // Today is excluded so partial in-progress days don't appear.
    expect(dates).not.toContain('2026-05-16');

    vi.useRealTimers();
  });

  // Regression: `aggregateAndPruneHistory` folds only >30-day-old hours into
  // persisted `hourlyAverages`; the most-recent-30-days stay in `tracker.buckets`.
  // `getPowerStats` used to read persisted `hourlyAverages` outright once non-empty,
  // dropping every recent hour from the Typical-day chart. The merge must fold
  // bucket-derived recent hours in additively.
  it('collapses a DST fall-back duplicated hour into one sample', async () => {
    const { getDerivedHourlyAverages } = await import('../src/ui/powerStats.ts');
    // Europe/Oslo falls back 2025-10-26 03:00 -> 02:00, so 00:00Z and 01:00Z
    // both land on wall-clock hour 02 of that Sunday. They must aggregate as ONE
    // sample (summed) — matching tracker.ts processDayHourBuckets — not two, or
    // the additive merge with persisted hourlyAverages double-weights the hour.
    const buckets = {
      '2025-10-26T00:00:00.000Z': 1, // 02:00 CEST
      '2025-10-26T01:00:00.000Z': 2, // 02:00 CET (the repeated hour)
    };
    const averages = getDerivedHourlyAverages(buckets, 'Europe/Oslo');
    // 2025-10-26 is a Sunday -> getUTCDay() === 0; wall-clock hour 2.
    expect(averages['0_2']).toEqual({ sum: 3, count: 1 });
    expect(Object.keys(averages)).toEqual(['0_2']);
  });

  it('merges recent buckets into the typical-day pattern, not only the aged slice', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 16, 12, 0, 0))); // 2026-05-16 12:00 UTC

    // Persisted (aged) slice: Monday hour 8 = 5 kWh over a single observed day.
    // 2026-05-11 is a Monday → getUTCDay() === 1.
    const hourlyAverages = { '1_8': { sum: 5, count: 1 } };

    // Recent buckets: Monday 2026-05-11 hour 8 = 1 kWh (within 30-day window, still in
    // buckets). Same weekday/hour slot as the persisted entry.
    const buckets = { '2026-05-11T08:00:00.000Z': 1 };

    await installHomeyClient({ hourlyAverages, buckets });

    const { getPowerStats } = await import('../src/ui/power.ts');
    const { stats } = await getPowerStats();

    const mondayHour8 = stats.hourlyPatternWeekday.find((point) => point.hour === 8);
    expect(mondayHour8).toBeDefined();
    // Merged: (5 + 1) / (1 + 1) = 3. The persisted-only path would have shown 5/1 = 5,
    // ignoring the recent bucket entirely.
    expect(mondayHour8?.avg).toBeCloseTo(3, 6);

    vi.useRealTimers();
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

  it('clears the heatmap box and shows selected-week copy when that week has no entries', async () => {
    await installHomeyClient({}, 'UTC');
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2025, 0, 15, 12, 0, 0));
    const { renderPowerUsage } = await import('../src/ui/power.ts');

    renderPowerUsage([{ hour: new Date('2025-01-13T00:00:00.000Z'), kWh: 1.2 }]);
    const powerList = document.querySelector('#power-list') as HTMLElement;
    const powerEmpty = document.querySelector('#power-empty') as HTMLElement;
    expect(powerList.querySelector('svg')).not.toBeNull();
    // Container sizing now lives in `.power-week-chart` CSS — the renderer
    // must not write `height` / `min-height` / `-webkit-tap-highlight-color`
    // onto the container's inline style (echarts itself writes
    // `position: relative` for its own layout, which is fine).
    expect(powerList.style.height).toBe('');
    expect(powerList.style.minHeight).toBe('');
    expect(powerList.style.getPropertyValue('-webkit-tap-highlight-color')).toBe('');
    expect(powerList.classList.contains('power-week-chart')).toBe(true);

    renderPowerUsage([{ hour: new Date('2025-01-06T00:00:00.000Z'), kWh: 0.8 }]);

    expect(powerList.querySelector('svg')).toBeNull();
    expect(powerList.style.height).toBe('');
    expect(powerList.style.minHeight).toBe('');
    expect(powerList.style.getPropertyValue('-webkit-tap-highlight-color')).toBe('');
    expect(powerEmpty.hidden).toBe(false);
    expect(powerEmpty.textContent).toBe('No hourly usage for the selected week.');
    vi.restoreAllMocks();
  });

  it('does not leak inline styles onto the heatmap container when echarts render fails', async () => {
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts: vi.fn(() => {
        throw new Error('boom');
      }),
      encodeHtml: (value: string) => value,
    }));
    const { renderPowerWeekChart } = await import('../src/ui/powerWeekChartEcharts.ts');
    const powerList = document.querySelector('#power-list') as HTMLElement;

    const rendered = renderPowerWeekChart({
      container: powerList,
      entries: [{ hour: new Date('2025-01-13T00:00:00.000Z'), kWh: 1.2 }],
      startMs: Date.parse('2025-01-13T00:00:00.000Z'),
      endMs: Date.parse('2025-01-20T00:00:00.000Z'),
      timeZone: 'UTC',
    });

    expect(rendered).toBe(false);
    // Container sizing lives in `.power-week-chart` CSS; the renderer must
    // not write its own `height`/`min-height`/`-webkit-tap-highlight-color`
    // onto the container, including on the failure path.
    expect(powerList.style.height).toBe('');
    expect(powerList.style.minHeight).toBe('');
    expect(powerList.style.getPropertyValue('-webkit-tap-highlight-color')).toBe('');
    vi.doUnmock('../src/ui/echartsRegistry.ts');
  });

  it('aggregates repeated fall-back local hours into one honest heatmap cell', async () => {
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
    const { renderPowerWeekChart } = await import('../src/ui/powerWeekChartEcharts.ts');
    const powerList = document.querySelector('#power-list') as HTMLElement;

    const rendered = renderPowerWeekChart({
      container: powerList,
      entries: [
        { hour: new Date('2025-10-26T00:00:00.000Z'), kWh: 0.7 },
        { hour: new Date('2025-10-26T01:00:00.000Z'), kWh: 0.8 },
      ],
      // Europe/Oslo local week: 2025-10-20 00:00 through 2025-10-27 00:00.
      startMs: Date.parse('2025-10-19T22:00:00.000Z'),
      endMs: Date.parse('2025-10-26T23:00:00.000Z'),
      timeZone: 'Europe/Oslo',
    });

    expect(rendered).toBe(true);
    const option = setOption.mock.calls[0][0] as {
      series?: Array<{ type?: string; data?: Array<{ value: [number, number, number]; bucketCount?: number }> }>;
      tooltip?: { formatter?: (params: unknown) => string };
      visualMap?: { max?: number };
    };
    const heatmapData = option.series?.find((series) => series.type === 'heatmap')?.data ?? [];
    expect(heatmapData).toHaveLength(1);
    expect(heatmapData[0]?.value[1]).toBe(2);
    expect(heatmapData[0]?.value[2]).toBeCloseTo(1.5, 6);
    expect(heatmapData[0]?.bucketCount).toBe(2);
    expect(option.visualMap?.max).toBeCloseTo(1.5, 6);
    const tooltip = option.tooltip?.formatter?.({ data: heatmapData[0] }) ?? '';
    expect(tooltip).toContain('1.50 kWh total');
    // The "kWh total" suffix already signals aggregation; the bucket-count
    // line exposed internal vocabulary and has been dropped (v2.7.4 train).
    expect(tooltip).not.toMatch(/measured hours/i);
    vi.doUnmock('../src/ui/echartsRegistry.ts');
  });

  it('uses local week boundaries when navigating across DST', async () => {
    await installHomeyClient({}, 'Europe/Oslo');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2025-03-31T12:00:00.000Z'));
    const { renderPowerUsage } = await import('../src/ui/power.ts');
    const entries = [
      // 2025-03-23 23:30 in Europe/Oslo is still the Sunday before the selected local week.
      { hour: new Date('2025-03-23T22:30:00.000Z'), kWh: 0.8 },
    ];

    renderPowerUsage(entries);
    const prev = document.querySelector('#power-week-prev') as HTMLButtonElement;
    prev.click();

    const powerList = document.querySelector('#power-list') as HTMLElement;
    const powerEmpty = document.querySelector('#power-empty') as HTMLElement;
    expect(powerList.querySelector('svg')).toBeNull();
    expect(powerEmpty.hidden).toBe(false);
    expect(powerEmpty.textContent).toBe('No hourly usage for the selected week.');
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
    // Container sizing lives in `.power-week-chart` CSS; the renderer must
    // not write its own `height`/`min-height` onto the container.
    expect(powerList.style.height).toBe('');
    expect(powerList.style.minHeight).toBe('');
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

  it('clears and hides the pinned readout when switching to a day with no data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    await installHomeyClient({}, 'UTC');
    const { renderUsageDayView } = await import('../src/ui/usageDayView.ts');
    const readout = document.querySelector('#usage-day-readout') as HTMLElement;

    // Data render populates and shows the pinned readout row.
    renderUsageDayView([{
      hour: new Date('2025-01-06T12:00:00.000Z'),
      kWh: 2.5,
      controlledKWh: 1.1,
      uncontrolledKWh: 1.4,
    }]);
    expect(readout.hidden).toBe(false);
    // Readout segments join tokens with NBSP (see `chartTooltipFormat.ts`).
    expect(readout.textContent).toContain('Measured 2.50 kWh');

    // Re-render with no entries for the selected day (the day-switch path):
    // the previous day's readout must not stay visible under "no data".
    renderUsageDayView([]);
    expect(readout.hidden).toBe(true);
    expect(readout.textContent).toBe('');
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

  // Regression: TODO 1122. Legend listed "Warning" but no series bound to it,
  // so ECharts silently dropped the entry. The chart now adds a zero-data
  // dummy series named "Warning" only when warn bars are present.
  it('binds the Warning legend entry to a real series when warn bars exist', async () => {
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
        { label: '01:00', value: 0.4, state: 'warn' },
      ],
      labels: ['00:00', '01:00'],
      currentBucketIndex: 0,
      enabled: true,
      barsEl,
      labelsEl,
    });

    expect(rendered).toBe(true);
    const option = setOption.mock.calls[0][0] as {
      legend?: { data?: Array<string | { name?: string }> };
      series?: Array<{ name?: string; data?: unknown[] }>;
    };
    const legendNames = (option.legend?.data ?? []).map((entry) => (
      typeof entry === 'string' ? entry : entry.name
    ));
    const seriesNames = (option.series ?? []).map((series) => series.name);
    for (const name of legendNames) {
      expect(seriesNames).toContain(name);
    }
    const warningSeries = option.series?.find((series) => series.name === 'Warning');
    expect(warningSeries).toBeDefined();
    expect(warningSeries?.data).toEqual([]);
  });

  // Regression: TODO 1122. Without warn bars the chart should not register a
  // ghost "Warning" entry — the legend is a single-item row.
  it('omits the Warning legend entry when no warn bars are present', async () => {
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

    renderUsageDayChartEcharts({
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

    const option = setOption.mock.calls[0][0] as {
      legend?: { data?: Array<string | { name?: string }> };
      series?: Array<{ name?: string }>;
    };
    const legendNames = (option.legend?.data ?? []).map((entry) => (
      typeof entry === 'string' ? entry : entry.name
    ));
    expect(legendNames).toEqual(['Measured']);
    expect(option.series?.find((series) => series.name === 'Warning')).toBeUndefined();
  });

  // Regression: PR #842 review. `roundedAxisMaxToInterval` can pick a 0.25 step
  // in the sub-kWh regime (e.g. dataMax=0.95 → max=1, interval=0.25), so a
  // flat one-decimal axis formatter would render the 0.25 tick as "0.3" and
  // the 0.75 tick as "0.8" — axis text drifting from tick position.
  it('formats sub-kWh axis ticks at the interval precision (0.25 step keeps 2 decimals)', async () => {
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

    renderUsageDayChartEcharts({
      bars: [
        // dataMax=0.95 → roundedAxisMaxToInterval picks max=1, interval=0.25.
        { label: '00:00', value: 0.95 },
        { label: '01:00', value: 0.4 },
      ],
      labels: ['00:00', '01:00'],
      currentBucketIndex: 0,
      enabled: true,
      barsEl,
      labelsEl,
    });

    const option = setOption.mock.calls[0][0] as {
      yAxis?: { max?: number; interval?: number; axisLabel?: { formatter?: (value: number) => string } };
    };
    expect(option.yAxis?.max).toBe(1);
    expect(option.yAxis?.interval).toBe(0.25);
    const formatter = option.yAxis?.axisLabel?.formatter;
    expect(formatter).toBeDefined();
    expect(formatter?.(0)).toBe('0');
    expect(formatter?.(0.25)).toBe('0.25');
    expect(formatter?.(0.5)).toBe('0.5');
    expect(formatter?.(0.75)).toBe('0.75');
    expect(formatter?.(1)).toBe('1');
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

  it('passes structured measured readout content for the usage day chart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 6, 12, 0, 0)));
    await installHomeyClient({}, 'UTC');
    type CapturedParams = {
      bars: Array<{ title?: string; marker?: { value: number } }>;
      readouts?: Array<{ when: string; values: Array<{ text: string; tone?: string }> }>;
      defaultReadoutIndex?: number;
    };
    let captured: CapturedParams | null = null;
    const renderUsageDayChartEcharts = vi.fn((params: CapturedParams) => {
      captured = params;
      return true;
    });
    vi.doMock('../src/ui/usageDayChartEcharts.ts', () => ({ renderUsageDayChartEcharts }));
    const { renderUsageDayView } = await import('../src/ui/usageDayView.ts');

    renderUsageDayView([{
      hour: new Date('2025-01-06T00:00:00.000Z'),
      kWh: 2.5,
      budgetKWh: 2.0,
    }]);

    const params = captured as CapturedParams | null;
    expect(params?.bars[0]?.title).toBeUndefined();
    expect(params?.bars[0]?.marker).toBeUndefined();
    expect(params?.readouts?.[0]?.when).toBe('00:00–01:00');
    // Measurement segments join with NBSP so units never wrap away from
    // their number (wraps only at the ` · ` separators).
    expect(params?.readouts?.[0]?.values).toEqual([{ text: 'Measured 2.50 kWh'.split(' ').join(' ') }]);
    // Today view at 12:00 UTC → the current hour (12) is the default
    // selection, and only that in-progress bucket carries the "so far"
    // suffix.
    expect(params?.defaultReadoutIndex).toBe(12);
    expect(params?.readouts?.[12]?.values[0]?.text).toBe('Measured 0.00 kWh so far'.split(' ').join(' '));
    vi.useRealTimers();
  });

  it('sources the daily-history budget from the active daily-budget payload, unclamped', async () => {
    // Stored budget 12 kWh sits BELOW the budget-adjust slider floor (20):
    // the adjust draft clamps it up on read, so the chart must source the
    // active payload instead and keep the stored value (P1 regression — the
    // mark line/readout said 20.0 while the Budget hero said 12.0).
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 24, 1.0);
    await installHomeyClient({ buckets });
    type DailyParams = { points: unknown[]; budgetKWh?: number | null; leadingPartialDay?: boolean };
    let captured: DailyParams | null = null;
    vi.doMock('../src/ui/usageStatsChartsEcharts.ts', () => ({
      renderDailyHistoryChartEcharts: vi.fn((params: DailyParams) => {
        captured = params;
        return true;
      }),
      renderHourlyPatternChartEcharts: vi.fn(() => true),
    }));
    const { setActiveDailyBudgetFromPayload } = await import('../src/ui/activeDailyBudget.ts');
    setActiveDailyBudgetFromPayload({
      todayKey: '2025-01-06',
      days: { '2025-01-06': { budget: { enabled: true, dailyBudgetKWh: 12 } } },
    } as never);
    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    const params = captured as DailyParams | null;
    expect(params?.points).toHaveLength(1);
    expect(params?.budgetKWh).toBe(12);
    // Full-day bucket coverage on the oldest day → no partial-day flag.
    expect(params?.leadingPartialDay).toBe(false);
  });

  it('passes no budget context to the daily-history chart when the budget is disabled', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 24, 1.0);
    await installHomeyClient({ buckets });
    type DailyParams = { points: unknown[]; budgetKWh?: number | null };
    let captured: DailyParams | null = null;
    vi.doMock('../src/ui/usageStatsChartsEcharts.ts', () => ({
      renderDailyHistoryChartEcharts: vi.fn((params: DailyParams) => {
        captured = params;
        return true;
      }),
      renderHourlyPatternChartEcharts: vi.fn(() => true),
    }));
    const { setActiveDailyBudgetFromPayload } = await import('../src/ui/activeDailyBudget.ts');
    setActiveDailyBudgetFromPayload({
      todayKey: '2025-01-06',
      days: { '2025-01-06': { budget: { enabled: false, dailyBudgetKWh: 12 } } },
    } as never);
    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    // null suppresses the mark line and the readout's budget context line.
    expect((captured as DailyParams | null)?.budgetKWh).toBeNull();
  });

  it('re-renders the daily-history chart when the active budget value changes', async () => {
    // A budget edit while the Usage tab is visible must move the mark line,
    // bar tinting, and readout budget context immediately: `dailyBudget.ts`
    // pushes every payload refresh into `activeDailyBudget.ts`, whose change
    // listener repaints the chart from the cached stats (no stats refetch).
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 24, 1.0);
    await installHomeyClient({ buckets });
    type DailyParams = { budgetKWh?: number | null };
    const renderDaily = vi.fn<(params: DailyParams) => boolean>(() => true);
    vi.doMock('../src/ui/usageStatsChartsEcharts.ts', () => ({
      renderDailyHistoryChartEcharts: renderDaily,
      renderHourlyPatternChartEcharts: vi.fn(() => true),
    }));
    const payloadWithBudget = (dailyBudgetKWh: number) => ({
      todayKey: '2025-01-06',
      days: { '2025-01-06': { budget: { enabled: true, dailyBudgetKWh } } },
    } as never);
    const { setActiveDailyBudgetFromPayload } = await import('../src/ui/activeDailyBudget.ts');
    setActiveDailyBudgetFromPayload(payloadWithBudget(12));
    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();
    expect(renderDaily.mock.lastCall?.[0]?.budgetKWh).toBe(12);

    renderDaily.mockClear();
    setActiveDailyBudgetFromPayload(payloadWithBudget(8));
    expect(renderDaily).toHaveBeenCalledTimes(1);
    expect(renderDaily.mock.calls[0]?.[0]?.budgetKWh).toBe(8);

    // Same stored value again → no redundant repaint.
    renderDaily.mockClear();
    setActiveDailyBudgetFromPayload(payloadWithBudget(8));
    expect(renderDaily).not.toHaveBeenCalled();
  });

  it('flags the window-clipped oldest history day to the daily-history chart', async () => {
    // Bucket coverage of the oldest (and only) history day starts at 10:00
    // local — the producer resolves the partial-day flag for the readout.
    const buckets = buildBuckets('2025-01-06T10:00:00.000Z', 14, 1.0);
    await installHomeyClient({ buckets });
    type DailyParams = { leadingPartialDay?: boolean };
    let captured: DailyParams | null = null;
    vi.doMock('../src/ui/usageStatsChartsEcharts.ts', () => ({
      renderDailyHistoryChartEcharts: vi.fn((params: DailyParams) => {
        captured = params;
        return true;
      }),
      renderHourlyPatternChartEcharts: vi.fn(() => true),
    }));
    const { renderPowerStats } = await import('../src/ui/power.ts');
    await renderPowerStats();

    expect((captured as DailyParams | null)?.leadingPartialDay).toBe(true);
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

describe('resolveActiveDailyBudgetKWh', () => {
  const payloadWith = (budget: { enabled: boolean; dailyBudgetKWh: number }) => ({
    todayKey: '2025-01-06',
    days: { '2025-01-06': { budget } },
  } as never);

  it('returns the stored value even below the adjust slider floor', async () => {
    const { resolveActiveDailyBudgetKWh } = await import('../src/ui/activeDailyBudget.ts');
    expect(resolveActiveDailyBudgetKWh(payloadWith({ enabled: true, dailyBudgetKWh: 12 }))).toBe(12);
  });

  it('returns null when the budget is disabled, missing, or non-positive', async () => {
    const { resolveActiveDailyBudgetKWh } = await import('../src/ui/activeDailyBudget.ts');
    expect(resolveActiveDailyBudgetKWh(payloadWith({ enabled: false, dailyBudgetKWh: 12 }))).toBeNull();
    expect(resolveActiveDailyBudgetKWh(payloadWith({ enabled: true, dailyBudgetKWh: 0 }))).toBeNull();
    expect(resolveActiveDailyBudgetKWh(payloadWith({ enabled: true, dailyBudgetKWh: Number.NaN }))).toBeNull();
    expect(resolveActiveDailyBudgetKWh(null)).toBeNull();
  });
});

describe('isLeadingHistoryDayPartial', () => {
  const timeZone = 'UTC';
  // `buildDailyHistory` output is desc-sorted: oldest day last.
  const history = [
    { date: '2025-01-07', kWh: 24 },
    { date: '2025-01-06', kWh: 14 },
  ];

  it('flags the oldest day when its bucket coverage starts after local midnight', async () => {
    const { isLeadingHistoryDayPartial } = await import('../src/ui/powerStats.ts');
    const buckets = buildBuckets('2025-01-06T10:00:00.000Z', 38, 1);
    expect(isLeadingHistoryDayPartial({
      history, persistedDailyTotals: undefined, buckets, timeZone,
    })).toBe(true);
  });

  it('does not flag when coverage starts at the local day start', async () => {
    const { isLeadingHistoryDayPartial } = await import('../src/ui/powerStats.ts');
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 48, 1);
    expect(isLeadingHistoryDayPartial({
      history, persistedDailyTotals: undefined, buckets, timeZone,
    })).toBe(false);
  });

  it('trusts a persisted full-day total over late bucket coverage', async () => {
    const { isLeadingHistoryDayPartial } = await import('../src/ui/powerStats.ts');
    const buckets = buildBuckets('2025-01-06T10:00:00.000Z', 38, 1);
    expect(isLeadingHistoryDayPartial({
      history, persistedDailyTotals: { '2025-01-06': 14 }, buckets, timeZone,
    })).toBe(false);
  });

  it('returns false for an empty history', async () => {
    const { isLeadingHistoryDayPartial } = await import('../src/ui/powerStats.ts');
    expect(isLeadingHistoryDayPartial({
      history: [], persistedDailyTotals: undefined, buckets: undefined, timeZone,
    })).toBe(false);
  });
});

describe('daily-history date labels in negative-offset zones', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('labels each bar by its LOCAL calendar date in America/New_York', async () => {
    // Regression: `new Date(`${key}T00:00:00.000Z`)` anchors a local date
    // key at UTC midnight, which negative-offset zones (America/*) format as
    // the PREVIOUS local day — the axis label, pinned readout, and tooltip
    // all said Jan 5 for the 2025-01-06 bar. Labels must come from the key's
    // local day start in the configured zone.
    // Earlier tests in this file `doMock` the whole chart module; this test
    // needs the real implementation with only the echarts seam stubbed.
    vi.doUnmock('../src/ui/usageStatsChartsEcharts.ts');
    const setOption = vi.fn();
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts: vi.fn(() => ({ setOption, resize: vi.fn(), dispose: vi.fn() })),
      encodeHtml: (value: string) => value,
    }));
    const { renderDailyHistoryChartEcharts } = await import('../src/ui/usageStatsChartsEcharts.ts');
    const container = document.createElement('div');
    document.body.appendChild(container);

    const rendered = renderDailyHistoryChartEcharts({
      container,
      points: [{ date: '2025-01-06', kWh: 10 }],
      timeZone: 'America/New_York',
    });

    expect(rendered).toBe(true);
    const option = setOption.mock.calls[0]?.[0] as {
      xAxis: { data: string[] };
      tooltip: { formatter: (params: unknown) => string };
    };
    // Axis caption: the key's own day number, never the UTC-midnight
    // previous day. (Day-number assertions keep the check locale-agnostic.)
    expect(option.xAxis.data[0]).toMatch(/6/);
    expect(option.xAxis.data[0]).not.toMatch(/5/);
    // The tooltip formatter and the pinned readout (incl. its default
    // selection) share the same prebuilt `readouts` array, so this covers
    // both surfaces.
    const tooltipHtml = option.tooltip.formatter([{ dataIndex: 0 }]);
    expect(tooltipHtml).toMatch(/6/);
    expect(tooltipHtml).not.toMatch(/5/);
  });
});
