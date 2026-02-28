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
    <div id="daily-budget-confidence"></div>
    <div id="daily-budget-status-pill"></div>
    <button id="daily-budget-toggle-today"></button>
    <button id="daily-budget-toggle-tomorrow"></button>
    <button id="daily-budget-toggle-yesterday"></button>
    <input id="daily-budget-breakdown" type="checkbox">
  `;
};

const installHomeyClient = (payload: unknown) => {
  const { setHomeyClient } = require('../settings/src/ui/homey') as typeof import('../settings/src/ui/homey');
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

    const { refreshDailyBudgetPlan } = require('../settings/src/ui/dailyBudget') as typeof import('../settings/src/ui/dailyBudget');
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
    jest.doMock('../settings/src/ui/echartsRegistry', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const { renderDailyBudgetChartEcharts } = require('../settings/src/ui/dailyBudgetChartEcharts') as typeof import('../settings/src/ui/dailyBudgetChartEcharts');
    const barsEl = document.querySelector('#daily-budget-bars') as HTMLElement;
    const labelsEl = document.querySelector('#daily-budget-labels') as HTMLElement;

    const rendered = renderDailyBudgetChartEcharts({
      bars: [{ label: '00:00', value: 1, title: '00:00 · Planned 1.00 kWh' }],
      planned: [1],
      actual: [0.8],
      plannedUncontrolled: [0.6],
      plannedControlled: [0.4],
      labels: ['00:00'],
      currentBucketIndex: 0,
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
});
