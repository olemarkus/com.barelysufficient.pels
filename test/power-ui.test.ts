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
  `;
};

const installHomeyClient = (tracker: unknown) => {
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

  it('renders hourly pattern bars from buckets when hourlyAverages are missing', async () => {
    const buckets = buildBuckets('2025-01-06T00:00:00.000Z', 24, 1.2);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const rows = document.querySelectorAll('.usage-row--pattern');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('renders daily history rows from buckets when dailyTotals are missing', async () => {
    const buckets = buildBuckets('2025-01-01T00:00:00.000Z', 5 * 24, 0.6);
    installHomeyClient({ buckets });

    const { renderPowerStats } = require('../settings/src/ui/power') as typeof import('../settings/src/ui/power');
    await renderPowerStats();

    const rows = document.querySelectorAll('.usage-row--daily');
    expect(rows.length).toBeGreaterThan(0);
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

  it('shows cap detail on the usage bar when hourly budget is present', async () => {
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
    const titled = document.querySelectorAll('.power-meter[title*="cap"]');
    expect(titled.length).toBeGreaterThan(0);
    jest.restoreAllMocks();
  });
});
