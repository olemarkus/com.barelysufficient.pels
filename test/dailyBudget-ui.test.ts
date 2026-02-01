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
    <div id="daily-budget-legend">
      <div class="daily-budget-legend__item">
        <span id="daily-budget-legend-planned-swatch" class="daily-budget-legend__swatch"></span>
        <span class="muted" id="daily-budget-legend-planned-label">Planned</span>
      </div>
      <div class="daily-budget-legend__item" id="daily-budget-legend-controlled" hidden>
        <span class="daily-budget-legend__swatch"></span>
        <span class="muted">Controlled</span>
      </div>
      <div class="daily-budget-legend__item" id="daily-budget-legend-actual">
        <span class="daily-budget-legend__swatch"></span>
        <span class="muted">Actual</span>
      </div>
    </div>
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

const getVisibleLegendLabels = () => {
  const items = Array.from(document.querySelectorAll('.daily-budget-legend__item')) as HTMLElement[];
  return items
    .map((item) => item.querySelector('.muted')?.textContent?.trim() || '')
    .filter(Boolean);
};

describe('daily budget legend', () => {
  beforeEach(() => {
    jest.resetModules();
    setupDailyBudgetDom();
  });

  it('shows only planned and actual labels when stacking is off', async () => {
    const breakdownInput = document.querySelector('#daily-budget-breakdown') as HTMLInputElement | null;
    if (breakdownInput) breakdownInput.checked = false;

    installHomeyClient(buildDailyBudgetPayload());

    const { refreshDailyBudgetPlan } = require('../settings/src/ui/dailyBudget') as typeof import('../settings/src/ui/dailyBudget');
    await refreshDailyBudgetPlan();

    const labels = getVisibleLegendLabels();
    expect(labels).toEqual(['Planned', 'Actual']);

    const controlledItem = document.querySelector('#daily-budget-legend-controlled') as HTMLElement | null;
    expect(controlledItem).toBeNull();
  });
});
