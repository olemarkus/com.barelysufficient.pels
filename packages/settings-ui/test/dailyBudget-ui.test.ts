const setupDailyBudgetDom = () => {
  document.body.innerHTML = `
    <div id="daily-budget-title"></div>
    <div id="daily-budget-day"></div>
    <div id="daily-budget-remaining"></div>
    <div id="daily-budget-deviation"></div>
    <div id="daily-budget-cost-label"></div>
    <div id="daily-budget-cost"></div>
    <div id="daily-budget-chart">
      <div id="daily-budget-bars"></div>
    </div>
    <div id="daily-budget-labels"></div>
    <div id="daily-budget-empty"></div>
    <div id="daily-budget-confidence" class="chip" hidden></div>
    <div id="daily-budget-status-pill"></div>
    <div id="daily-budget-toggle-mount"></div>
    <input id="daily-budget-breakdown" type="checkbox">
  `;
};

const installHomeyClient = (payload: unknown) => {
  const { setHomeyClient } = require('../src/ui/homey') as typeof import('../src/ui/homey');
  setHomeyClient({
    ready: async () => {},
    get: (_key, cb) => cb(null, null),
    set: (_key, _value, cb) => cb(null),
    api: (method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (!callback) return;
      if (method === 'GET' && uri === '/daily_budget') {
        callback(null, payload);
        return;
      }
      if (method === 'GET' && uri === '/ui_prices') {
        callback(null, {
          combinedPrices: null,
          electricityPrices: null,
          priceArea: null,
          gridTariffData: null,
          flowToday: null,
          flowTomorrow: null,
          homeyCurrency: null,
          homeyToday: null,
          homeyTomorrow: null,
        });
        return;
      }
      callback(null, null);
    },
    on: () => {},
  });
};

const buildDailyBudgetPayload = () => ({
  todayKey: '2026-02-01',
  tomorrowKey: null,
  yesterdayKey: null,
  days: {
    '2026-02-01': {
      dateKey: '2026-02-01',
      timeZone: 'UTC',
      nowUtc: '2026-02-01T10:00:00.000Z',
      dayStartUtc: '2026-02-01T00:00:00.000Z',
      currentBucketIndex: 2,
      budget: {
        enabled: true,
        dailyBudgetKWh: 12,
        priceShapingEnabled: true,
      },
      state: {
        usedNowKWh: 3,
        allowedNowKWh: 4,
        remainingKWh: 9,
        deviationKWh: 1,
        exceeded: false,
        frozen: false,
        confidence: 0.6,
        priceShapingActive: true,
      },
      buckets: {
        startUtc: [
          '2026-02-01T00:00:00.000Z',
          '2026-02-01T01:00:00.000Z',
          '2026-02-01T02:00:00.000Z',
        ],
        startLocalLabels: ['00:00', '01:00', '02:00'],
        plannedWeight: [1, 1, 1],
        plannedKWh: [1, 1.5, 2],
        plannedUncontrolledKWh: [0.6, 1, 1.2],
        plannedControlledKWh: [0.4, 0.5, 0.8],
        actualKWh: [0.8, 1.2, 1.9],
        actualControlledKWh: [0.3, 0.5, 0.7],
        actualUncontrolledKWh: [0.5, 0.7, 1.2],
        allowedCumKWh: [1, 2.5, 4.5],
      },
    },
  },
});

describe('daily budget chart render', () => {
  beforeEach(() => {
    jest.resetModules();
    setupDailyBudgetDom();
  });

  it('renders daily budget chart without the legacy html legend', async () => {
    const breakdownInput = document.querySelector('#daily-budget-breakdown') as HTMLInputElement | null;
    if (breakdownInput) breakdownInput.checked = false;

    installHomeyClient(buildDailyBudgetPayload());

    const { refreshDailyBudgetPlan } = require('../src/ui/dailyBudget') as typeof import('../src/ui/dailyBudget');
    await refreshDailyBudgetPlan();

    const chart = document.querySelector('#daily-budget-chart') as HTMLElement | null;
    const empty = document.querySelector('#daily-budget-empty') as HTMLElement | null;
    const legend = document.querySelector('#daily-budget-legend');
    expect(chart?.hidden).toBe(false);
    expect(empty?.hidden).toBe(true);
    expect(legend).toBeNull();
  });

  it('uses fallback chart width when container width is initially zero', () => {
    const setOption = jest.fn();
    const initEcharts = jest.fn(() => ({
      setOption,
      resize: jest.fn(),
      dispose: jest.fn(),
    }));
    jest.doMock('../src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const { renderDailyBudgetChartEcharts } = require('../src/ui/dailyBudgetChartEcharts') as typeof import('../src/ui/dailyBudgetChartEcharts');
    const barsEl = document.querySelector('#daily-budget-bars') as HTMLElement;
    const labelsEl = document.querySelector('#daily-budget-labels') as HTMLElement;

    const rendered = renderDailyBudgetChartEcharts({
      bars: [{ label: '00:00', value: 1, title: '00:00 · Planned 1.00 kWh' }],
      planned: [1],
      actual: [0.8],
      actualUncontrolled: [],
      actualControlled: [],
      plannedUncontrolled: [0.6],
      plannedControlled: [0.4],
      labels: ['00:00'],
      currentBucketIndex: 0,
      actualUpToIndex: 0,
      showActual: true,
      showBreakdown: true,
      enabled: true,
      barsEl,
      labelsEl,
    });

    expect(rendered).toBe(true);
    expect(initEcharts).toHaveBeenCalledWith(
      barsEl,
      undefined,
      expect.objectContaining({ renderer: 'svg', width: 480, height: 176 }),
    );
    expect(setOption).toHaveBeenCalledTimes(1);
  });

  it('stack OFF: renders Actual and Budget as two grouped series per hour', () => {
    const setOption = jest.fn();
    const initEcharts = jest.fn(() => ({ setOption, resize: jest.fn(), dispose: jest.fn() }));
    jest.doMock('../src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const { renderDailyBudgetChart } = require('../src/ui/dailyBudgetChart') as typeof import('../src/ui/dailyBudgetChart');
    const payload = buildDailyBudgetPayload().days['2026-02-01'];
    const barsEl = document.querySelector('#daily-budget-bars') as HTMLElement;
    const labelsEl = document.querySelector('#daily-budget-labels') as HTMLElement;

    renderDailyBudgetChart({ payload, showActual: true, showBreakdown: false, barsEl, labelsEl });

    expect(setOption).toHaveBeenCalledTimes(1);
    const option = setOption.mock.calls[0][0] as { series: Array<{ name: string }> };
    const names = option.series.map((s) => s.name);
    expect(names).toContain('Actual');
    expect(names).toContain('Budget');
  });

  it('stack ON: renders four grouped stacked series (actual + plan breakdown)', () => {
    const setOption = jest.fn();
    const initEcharts = jest.fn(() => ({ setOption, resize: jest.fn(), dispose: jest.fn() }));
    jest.doMock('../src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const { renderDailyBudgetChart } = require('../src/ui/dailyBudgetChart') as typeof import('../src/ui/dailyBudgetChart');
    const payload = buildDailyBudgetPayload().days['2026-02-01'];
    const barsEl = document.querySelector('#daily-budget-bars') as HTMLElement;
    const labelsEl = document.querySelector('#daily-budget-labels') as HTMLElement;

    renderDailyBudgetChart({ payload, showActual: true, showBreakdown: true, barsEl, labelsEl });

    expect(setOption).toHaveBeenCalledTimes(1);
    const option = setOption.mock.calls[0][0] as { series: Array<{ name: string; stack?: string }> };
    const names = option.series.map((s) => s.name);
    // Both actual and plan breakdown groups must be present
    expect(names).toContain('Actual Uncontrolled');
    expect(names).toContain('Actual Controlled');
    expect(names).toContain('Plan Uncontrolled');
    expect(names).toContain('Plan Controlled');
    // Actual and plan must use different stack keys (they are grouped side by side)
    const actualStack = option.series.find((s) => s.name === 'Actual Uncontrolled')?.stack;
    const planStack = option.series.find((s) => s.name === 'Plan Uncontrolled')?.stack;
    expect(actualStack).not.toBe(planStack);
  });

  it('tomorrow view: only Budget series is rendered (no Actual)', () => {
    const setOption = jest.fn();
    const initEcharts = jest.fn(() => ({ setOption, resize: jest.fn(), dispose: jest.fn() }));
    jest.doMock('../src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const { renderDailyBudgetChart } = require('../src/ui/dailyBudgetChart') as typeof import('../src/ui/dailyBudgetChart');
    const payload = buildDailyBudgetPayload().days['2026-02-01'];
    const barsEl = document.querySelector('#daily-budget-bars') as HTMLElement;
    const labelsEl = document.querySelector('#daily-budget-labels') as HTMLElement;

    renderDailyBudgetChart({ payload, showActual: false, showBreakdown: false, barsEl, labelsEl });

    const option = setOption.mock.calls[0][0] as { series: Array<{ name: string }> };
    const names = option.series.map((s) => s.name);
    expect(names).not.toContain('Actual');
    expect(names).toContain('Budget');
  });
});
