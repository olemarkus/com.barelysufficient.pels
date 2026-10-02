import api from '../../api';
import { partialDouble } from '../helpers/partialDouble';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { createWeatherHistoryStore } from '../../lib/weather/weatherHistoryStore';
// The boot window at the host-API façade. `hasDailyBudgetSeam` (settings/widget
// side) can only see that the prototype methods exist — they do, from
// construction — so whether the daily budget is READABLE has to be answered
// here, by the one object that can see whether the service was wired.
//
// The split under test: the read degrades to its named `unavailable` member,
// because that member exists precisely for this window; the two writes throw,
// because a command that cannot run must fail loudly rather than report a
// state it did not reach.
import { describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { withAppHostApi } from '../../setup/appHostApi';
import type { AppContext } from '../../lib/app/appContext';
import type { DailyBudgetUiRead } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { WeatherCollector } from '../../lib/weather/weatherCollector';
import { createWeatherCollector } from '../../setup/appInit/createWeatherCollector';
import { MockSettings } from '../mocks/homey';

const createHostApi = (
  dailyBudgetService: AppContext['dailyBudgetService'],
  overrides: Partial<AppContext> = {},
  weatherCollector?: WeatherCollector,
) => {
  const Base = withAppHostApi(Homey.App);
  class TestHostApi extends Base {
    protected readonly context = partialDouble<AppContext>({ dailyBudgetService, ...overrides });
    protected readonly getHomeOperatingMode = () => 'Home';
    protected readonly setHomeOperatingMode = (mode: string) => ({ previous: 'Home', resolved: mode });
    protected readonly reloadHomeModeCatalog = () => {};
    protected readonly resolveHomeModeName = (mode: string) => mode;
    protected readonly getHomeModeNames = () => new Set(['Home']);
    protected readonly listDeviceTargetModes = () => null;
    protected readonly setDeviceModeTarget = () => ({ state: 'unavailable' as const });

    protected readonly smartTaskApi = {} as never;

    protected readonly smartTaskPayloads = {} as never;

    protected weatherCollector = weatherCollector;

    public getCombinedPricesForUi = (): unknown => null;

    protected registerAppFlowCards(): void {}
  }
  return new TestHostApi();
};

describe('AppHostApi boot window', () => {
  it('reads unavailable while the service is not wired yet', () => {
    expect(createHostApi(undefined).getDailyBudgetUiPayload()).toEqual({ kind: 'unavailable' });
  });

  it('fails loudly on the two writes instead of reporting an apply that never ran', () => {
    const api = createHostApi(undefined);
    expect(() => api.previewDailyBudgetModel({})).toThrow('DailyBudgetService must be initialized');
    expect(() => api.applyDailyBudgetModel({})).toThrow('DailyBudgetService must be initialized');
  });

  it('serves the wired service once it exists', () => {
    const read: DailyBudgetUiRead = { kind: 'budget', payload: { days: {}, todayKey: '2026-03-03' } };
    const getUiPayload = vi.fn((): DailyBudgetUiRead => read);
    expect(createHostApi({ getUiPayload } as never).getDailyBudgetUiPayload()).toBe(read);
    expect(getUiPayload).toHaveBeenCalledTimes(1);
  });

  it('reports price-optimization setup as unavailable before its owner is wired', () => {
    expect(createHostApi(undefined).readPriceOptimizationSetup()).toEqual({ state: 'unavailable' });
  });
});


describe('budget history app API wiring', () => {
  it('reads persisted evidence through the actual API handler even without a running weather collector', async () => {
    const db = openUserdataDatabase(IN_MEMORY_DATABASE);
    try {
      createWeatherHistoryStore(db).write({ records: [{
        dateKey: '2026-10-01', kwhTotal: 42.5, appliedBudgetKwh: 112.8,
        tempMeanC: 16, tempMinC: 12, tempMaxC: 18, tempSampleCount: 24,
        quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
      }] });
      const context = partialDouble<AppContext>({
        homey: { settings: new MockSettings() } as unknown as AppContext['homey'],
        getUserdataDatabase: () => db, getNow: () => new Date('2026-10-03T06:00:00Z'),
        getTimeZone: () => 'Europe/Oslo',
      });
      // The production wiring, constructed but never started: the diagnostics
      // read goes through the collector's own store instances.
      const host = createHostApi(undefined, context, createWeatherCollector(context));
      const homey = partialDouble<Homey.App['homey']>({ app: host });
      const query = { from: '2026-10-01', to: '2026-10-02' };
      const days = await api.diagnostics_budget_days({ homey, query });
      expect(days.records[0]).toMatchObject({ dateKey: '2026-10-01', kwhTotal: 42.5, appliedBudgetKwh: 112.8 });
      expect(days.meta.missingDates).toEqual(['2026-10-02']);
      const decisions = await api.diagnostics_budget_decisions({ homey, query });
      expect(decisions.records).toEqual([]);
      expect(decisions.meta.missingDates).toEqual(['2026-10-01', '2026-10-02']);
    } finally { db.close(); }
  });

  it('reports the startup window instead of building a second store', () => {
    const host = createHostApi(undefined);
    expect(() => host.getBudgetDailyHistory({ from: '2026-10-01', to: '2026-10-02' }))
      .toThrow('Budget history is unavailable during startup');
    expect(() => host.getBudgetDecisionHistory({ from: '2026-10-01', to: '2026-10-02' }))
      .toThrow('Budget history is unavailable during startup');
  });
});
