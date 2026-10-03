import type { Logger as PinoLogger } from 'pino';
import { performBudgetAutoApply } from '../../lib/weather/weatherAutoApply';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

const NOW_MS = 1_700_000_000_000;
const logger = { info: vi.fn() } as unknown as PinoLogger;

const baseState = (over: Partial<WeatherHistoryState> = {}): WeatherHistoryState => ({
  records: [],
  latestSuggestion: {
    targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4,
  } as WeatherHistoryState['latestSuggestion'],
  ...over,
});

const deps = (over: Partial<Parameters<typeof performBudgetAutoApply>[1]> = {}) => ({
  getSettings: () => ({ enabled: true, autoApplyDailyBudget: true }),
  getNowMs: () => NOW_MS,
  applySuggestedDailyBudget: vi.fn(() => true),
  onDailyBudgetAutoApplied: vi.fn(),
  logger,
  ...over,
});

describe('performBudgetAutoApply', () => {
  it('applies the suggestion and stamps the audit when opted in', () => {
    const d = deps();
    const next = performBudgetAutoApply(baseState(), d);
    expect(d.applySuggestedDailyBudget).toHaveBeenCalledWith(48);
    expect(next.lastAutoApply).toEqual({ dateKey: '2026-01-11', kwh: 48, appliedAtMs: NOW_MS });
  });

  it('notifies the Flow-trigger seam with the applied budget and the forecast temp that drove it', () => {
    const d = deps();
    performBudgetAutoApply(baseState(), d);
    expect(d.onDailyBudgetAutoApplied).toHaveBeenCalledWith({ budgetKwh: 48, forecastMeanTempC: -4 });
  });

  it('does NOT notify the Flow-trigger seam when nothing was applied', () => {
    const idempotent = deps();
    const prior = { dateKey: '2026-01-11', kwh: 40, appliedAtMs: 1 };
    performBudgetAutoApply(baseState({ lastAutoApply: prior }), idempotent);

    const budgetOff = deps({ applySuggestedDailyBudget: vi.fn(() => false) });
    performBudgetAutoApply(baseState(), budgetOff);

    expect(idempotent.onDailyBudgetAutoApplied).not.toHaveBeenCalled();
    expect(budgetOff.onDailyBudgetAutoApplied).not.toHaveBeenCalled();
  });

  it('lowers toward a recommendation that already includes pressure', () => {
    // Pressure affects the recommendation, never vetoes applying it.
    const d = deps({ getAppliedDailyBudgetKwh: () => 55 });
    const state = baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4, budgetPressureKwh: 0,
      } as WeatherHistoryState['latestSuggestion'],
      budgetPressure: { kwh: 4, throughDateKey: '2026-01-10' },
    });
    const next = performBudgetAutoApply(state, d);
    expect(d.applySuggestedDailyBudget).toHaveBeenCalledWith(48);
    expect(next.lastAutoApply?.kwh).toBe(48);
  });

  it('still RAISES freely under pressure, and still lowers when nothing ran past its budget', () => {
    const raising = deps({ getAppliedDailyBudgetKwh: () => 40 });
    performBudgetAutoApply(baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4, budgetPressureKwh: 4,
      } as WeatherHistoryState['latestSuggestion'],
      budgetPressure: { kwh: 4, throughDateKey: '2026-01-10' },
    }), raising);
    expect(raising.applySuggestedDailyBudget).toHaveBeenCalledWith(48);

    const noPressure = deps({ getAppliedDailyBudgetKwh: () => 55 });
    performBudgetAutoApply(baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4, budgetPressureKwh: 0,
      } as WeatherHistoryState['latestSuggestion'],
    }), noPressure);
    expect(noPressure.applySuggestedDailyBudget).toHaveBeenCalledWith(48);
  });

  it('allows lowering when a ceiling absorbs the pressure contribution', () => {
    // The ceiling must not freeze a larger configured budget.
    const d = deps({ getAppliedDailyBudgetKwh: () => 55 });
    performBudgetAutoApply(baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4, budgetPressureKwh: 0,
      } as WeatherHistoryState['latestSuggestion'],
      budgetPressure: { kwh: 13.9, throughDateKey: '2026-01-10' },
    }), d);
    expect(d.applySuggestedDailyBudget).toHaveBeenCalledWith(48);
  });

  it('does NOT block lowering merely because devices were held back', () => {
    // The one-way-ratchet guard. `budgetMayBeLimiting` is the ordinary state of
    // a home whose daily budget is doing its job; gating on it would mean
    // auto-apply could only ever raise, overriding a deliberately tight budget.
    const d = deps({ getAppliedDailyBudgetKwh: () => 55 });
    performBudgetAutoApply(baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11',
        suggestedBudgetKwh: 48,
        forecastMeanTempC: -4,
        budgetMayBeLimiting: true,
        budgetPressureKwh: 0,
      } as WeatherHistoryState['latestSuggestion'],
    }), d);
    expect(d.applySuggestedDailyBudget).toHaveBeenCalledWith(48);
  });

  it('is idempotent — skips a target day already applied (boot catch-up safety)', () => {
    const d = deps();
    const prior = { dateKey: '2026-01-11', kwh: 40, appliedAtMs: 1 };
    const next = performBudgetAutoApply(baseState({ lastAutoApply: prior }), d);
    expect(d.applySuggestedDailyBudget).not.toHaveBeenCalled();
    expect(next.lastAutoApply).toEqual(prior);
  });

  it('no-ops when off, when there is no suggestion, or when the applier reports the budget off', () => {
    const off = deps({ getSettings: () => ({ enabled: true, autoApplyDailyBudget: false }) });
    expect(performBudgetAutoApply(baseState(), off).lastAutoApply).toBeUndefined();
    expect(off.applySuggestedDailyBudget).not.toHaveBeenCalled();

    const noSuggestion = deps();
    expect(performBudgetAutoApply(baseState({ latestSuggestion: undefined }), noSuggestion).lastAutoApply)
      .toBeUndefined();
    expect(noSuggestion.applySuggestedDailyBudget).not.toHaveBeenCalled();

    const budgetOff = deps({ applySuggestedDailyBudget: vi.fn(() => false) });
    expect(performBudgetAutoApply(baseState(), budgetOff).lastAutoApply).toBeUndefined();
  });
});

describe('budget advice decision recording', () => {
  it.each([
    ['auto_apply_off', { getSettings: () => ({ enabled: true, autoApplyDailyBudget: false }) }],
    ['budget_disabled_or_unavailable', { applySuggestedDailyBudget: vi.fn(() => false) }],
  ] as const)('records %s with the prediction and accumulated pressure', (outcome, overrides) => {
    const recordBudgetDecision = vi.fn();
    const d = deps({ recordBudgetDecision, ...overrides });
    performBudgetAutoApply(baseState({
      meterScopeSignature: 'scope-a', budgetPressure: { kwh: 17.8, throughDateKey: '2026-01-10' },
    }), d);
    expect(recordBudgetDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome, suggestedBudgetKwh: 48, forecastMeanTempC: -4, pressureAccumulatorKwh: 17.8,
      meterScopeSignature: 'scope-a', budgetAfterKwh: null,
    }));
  });

  it('reads the applied value back, preserving rounding rather than claiming the suggestion was written exactly', () => {
    const recordBudgetDecision = vi.fn();
    const readBudget = vi.fn().mockReturnValueOnce(40).mockReturnValueOnce(48.1);
    const d = deps({ recordBudgetDecision, getAppliedDailyBudgetKwh: readBudget });
    performBudgetAutoApply(baseState(), d);
    expect(recordBudgetDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'applied', budgetBeforeKwh: 40, budgetAfterKwh: 48.1,
    }));
  });

  it('journal failures do not interrupt applies, audit stamps, or Flow notifications', () => {
    const warn = vi.fn();
    const d = deps({
      recordBudgetDecision: () => { throw new Error('disk full'); },
      logger: { info: vi.fn(), warn } as unknown as PinoLogger,
    });
    expect(performBudgetAutoApply(baseState(), d).lastAutoApply?.kwh).toBe(48);
    expect(d.onDailyBudgetAutoApplied).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'budget_advice_history_record_failed' }));
  });

  it('does not add a budget read when opted out without a journal, and contains journal read failures', () => {
    const readBudget = vi.fn(() => { throw new Error('read unavailable'); });
    const warn = vi.fn();
    const d = deps({
      getSettings: () => ({ enabled: true, autoApplyDailyBudget: false }),
      getAppliedDailyBudgetKwh: readBudget,
      logger: { info: vi.fn(), warn } as unknown as PinoLogger,
    });
    expect(performBudgetAutoApply(baseState(), d)).toEqual(baseState());
    expect(readBudget).not.toHaveBeenCalled();
    const recordBudgetDecision = vi.fn();
    expect(() => performBudgetAutoApply(baseState(), { ...d, recordBudgetDecision })).not.toThrow();
    expect(recordBudgetDecision).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not journal or reapply a day already applied', () => {
    const recordBudgetDecision = vi.fn();
    const d = deps({ recordBudgetDecision });
    performBudgetAutoApply(baseState({ lastAutoApply: {
      dateKey: '2026-01-11', kwh: 48, appliedAtMs: NOW_MS,
    } }), d);
    expect(recordBudgetDecision).not.toHaveBeenCalled();
    expect(d.applySuggestedDailyBudget).not.toHaveBeenCalled();
  });
});


describe('recorded sustainable daily ceiling', () => {
  it.each([['2026-03-29', 23], ['2026-10-25', 25]])('uses the actual Oslo day length for %s', (dateKey, hours) => {
    const recordBudgetDecision = vi.fn();
    performBudgetAutoApply(baseState({
      latestSuggestion: { ...baseState().latestSuggestion!, targetDateKey: dateKey },
    }), deps({ recordBudgetDecision, getTimeZone: () => 'Europe/Oslo', getSustainableCapacityKw: () => 4.7 }));
    expect(recordBudgetDecision.mock.calls[0][0].sustainableDailyCeilingKwh).toBeCloseTo(4.7 * hours);
  });
});
