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

  it('refuses to LOWER a budget the home has demonstrably been running past', () => {
    // Auto-apply is asymmetric: tightening a budget recent days already blew
    // through compounds the harm instead of correcting it.
    const d = deps({ getAppliedDailyBudgetKwh: () => 55 });
    const state = baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4, budgetPressureKwh: 0,
      } as WeatherHistoryState['latestSuggestion'],
      budgetPressure: { kwh: 4, throughDateKey: '2026-01-10' },
    });
    const next = performBudgetAutoApply(state, d);
    expect(d.applySuggestedDailyBudget).not.toHaveBeenCalled();
    expect(next.lastAutoApply).toBeUndefined();
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

  it('blocks lowering off the ACCUMULATOR even when the displayed contribution is 0', () => {
    // Regression: the guard used to read `suggestion.budgetPressureKwh`, which
    // is the post-clamp contribution and reads 0 whenever a floor or the hard
    // cap set the suggestion — disarming the guard for exactly the home whose
    // loop was most active.
    const d = deps({ getAppliedDailyBudgetKwh: () => 55 });
    performBudgetAutoApply(baseState({
      latestSuggestion: {
        targetDateKey: '2026-01-11', suggestedBudgetKwh: 48, forecastMeanTempC: -4, budgetPressureKwh: 0,
      } as WeatherHistoryState['latestSuggestion'],
      budgetPressure: { kwh: 13.9, throughDateKey: '2026-01-10' },
    }), d);
    expect(d.applySuggestedDailyBudget).not.toHaveBeenCalled();
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
