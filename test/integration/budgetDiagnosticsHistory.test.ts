import { performBudgetAutoApply } from '../../lib/weather/weatherAutoApply';
import type { Logger as PinoLogger } from 'pino';
import type { BudgetAdviceDecision } from '../../packages/contracts/src/budgetDiagnostics';
import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import { createWeatherHistoryStore } from '../../lib/weather/weatherHistoryStore';
import { createBudgetAdviceHistoryStore } from '../../lib/weather/budgetAdviceHistoryStore';
import { readBudgetDailyHistory, readBudgetDecisionHistory } from '../../lib/weather/budgetDiagnosticsHistory';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';

const NOW = Date.UTC(2026, 9, 3);
const TZ = 'Europe/Oslo';
const decision = (extra: Partial<BudgetAdviceDecision> = {}): BudgetAdviceDecision => ({
  recordedAtMs: NOW, targetDateKey: '2026-10-03', meterScopeSignature: 'source:homey_energy|main:meter-a',
  outcome: 'would_lower_while_limiting', budgetBeforeKwh: 112.8, budgetAfterKwh: null,
  suggestedBudgetKwh: 84.1, predictedKwh: 50.6, predictedLowKwh: 40, predictedHighKwh: 70,
  forecastMeanTempC: 11, forecastSource: 'met_api', computedAtMs: NOW - 1000,
  beyondObservedCold: false, beyondObservedWarm: false, budgetMayBeLimiting: true,
  sustainableDailyCeilingKwh: 112.8, pressureThroughDateKey: '2026-10-02',
  pressureAccumulatorKwh: 17.8, pressureContributionKwh: 17.8, modelPseudoR2: 0.56, modelUsableDays: 314,
  ...extra,
});
const day = (dateKey: string, extra: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  dateKey, tempMeanC: 13, tempMinC: 10, tempMaxC: 16, tempSampleCount: 24,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
  ...extra,
});

function open() {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, days: createWeatherHistoryStore(db), decisions: createBudgetAdviceHistoryStore(db) };
}

describe('persisted budget diagnostics history', () => {
  it('serves real daily evidence, preserves unknowns, and reports gaps instead of fabricating days', () => {
    const h = open();
    try {
      const records = [
        day('2026-09-30', { kwhTotal: 40 }),
        day('2026-10-01', { kwhTotal: 42.5, appliedBudgetKwh: 112.8,
          suppression: { budgetDenialObserved: true, budgetDeniedKwh: 0 } }),
        day('2026-10-03', { quality: {
          partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: true,
        } }),
      ];
      h.days.write({ records, meterScopeSignature: 'source:homey_energy|main:meter-a',
        budgetPressure: { algorithmVersion: 3, kwh: 17.8, throughDateKey: '2026-10-02' } });
      const response = readBudgetDailyHistory(h.days, { from: '2026-10-01', to: '2026-10-03' }, NOW, TZ);
      expect(response.records).toEqual(records.slice(1));
      expect(response.records[1].kwhTotal).toBeUndefined();
      expect(response.records[1].suppression).toBeUndefined();
      expect(response.meta).toMatchObject({
        timeZone: TZ, meterScopeSignature: 'source:homey_energy|main:meter-a', missingDates: ['2026-10-02'],
        retained: { from: '2026-09-30', to: '2026-10-03' },
      });
      expect(response.currentBudgetPressure?.kwh).toBe(17.8);
    } finally { h.db.close(); }
  });

  it('retains predictions across a new store instance and later outcomes without rewriting the earlier decision', () => {
    const h = open();
    try {
      h.decisions.record(decision());
      h.decisions.record(decision({ recordedAtMs: NOW + 1000, outcome: 'applied',
        budgetAfterKwh: 84.1, meterScopeSignature: 'source:homey_energy|main:meter-b' }));
      const reloaded = createBudgetAdviceHistoryStore(h.db);
      const response = readBudgetDecisionHistory(reloaded.read(), { from: '2026-10-02', to: '2026-10-03' }, NOW, TZ);
      expect(response.records.map((r) => r.outcome)).toEqual(['would_lower_while_limiting', 'applied']);
      expect(response.records[0]).toEqual(decision());
      expect(response.records[1].meterScopeSignature).toBe('source:homey_energy|main:meter-b');
      expect(response.meta.missingDates).toEqual(['2026-10-02']);
    } finally { h.db.close(); }
  });

  it('persists the actual auto-apply decision and its prior prediction through the runtime recording seam', () => {
    const h = open();
    try {
      let currentBudget = 112.8;
      performBudgetAutoApply({
        records: [], meterScopeSignature: 'source:homey_energy|main:meter-a',
        budgetPressure: { algorithmVersion: 3, kwh: 17.8, throughDateKey: '2026-10-02' },
        latestSuggestion: {
          targetDateKey: '2026-10-03', forecastMeanTempC: 11, forecastSource: 'met_api',
          predictedKwh: 50.6, predictedLowKwh: 40, predictedHighKwh: 70, suggestedBudgetKwh: 84.1,
          beyondObservedCold: false, beyondObservedWarm: false, budgetMayBeLimiting: true,
          budgetPressureKwh: 17.8, computedAtMs: NOW - 1000,
        },
      }, {
        getSettings: () => ({ enabled: true, autoApplyDailyBudget: true }),
        getNowMs: () => NOW, getTimeZone: () => TZ, getPowerLimitSettings: () => capacityOnlyPowerLimits(4.7),
        getAppliedDailyBudgetKwh: () => currentBudget,
        applySuggestedDailyBudget: (value) => { currentBudget = value; return true; },
        recordBudgetDecision: (record) => h.decisions.record(record),
        logger: { info: vi.fn(), warn: vi.fn() } as unknown as PinoLogger,
      });
      const [record] = readBudgetDecisionHistory(createBudgetAdviceHistoryStore(h.db).read(), {
        from: '2026-10-03', to: '2026-10-03',
      }, NOW, TZ).records;
      expect(record).toMatchObject({
        budgetAlgorithmVersion: 2, predictedKwh: 50.6, outcome: 'applied',
        budgetBeforeKwh: 112.8, budgetAfterKwh: 84.1,
        pressureAccumulatorKwh: 17.8, pressureThroughDateKey: '2026-10-02',
      });
      expect(record.sustainableDailyCeilingKwh).toBeCloseTo(112.8);
    } finally { h.db.close(); }
  });

  it('bounds the journal and never returns damaged predictions as valid evidence', () => {
    const h = open();
    try {
      for (let index = 0; index < 735; index += 1) {
        h.decisions.record(decision({ recordedAtMs: NOW + index }));
      }
      expect(h.decisions.read()).toHaveLength(730);
      expect(h.decisions.read()[0].recordedAtMs).toBe(NOW + 5);
      h.db.prepare('UPDATE budget_advice_decisions SET decision_json = ? WHERE sequence = ?')
        .run('{bad json', 735);
      expect(h.decisions.read()).toHaveLength(729);
    } finally { h.db.close(); }
  });

  it('reports empty retained history honestly', () => {
    const h = open();
    try {
      const query = { from: '2026-10-25', to: '2026-10-25' };
      expect(readBudgetDailyHistory(h.days, query, NOW, TZ)).toMatchObject({
        records: [], currentBudgetPressure: null,
        meta: { retained: null, missingDates: ['2026-10-25'], meterScopeSignature: null },
      });
      expect(readBudgetDecisionHistory(h.decisions.read(), query, NOW, TZ).meta.retained).toBeNull();
    } finally { h.db.close(); }
  });
});
