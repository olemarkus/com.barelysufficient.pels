import {
  DAILY_BUDGET_ALLOCATION_WARNING_TITLE,
  formatDailyBudgetAllocationWarningBody,
} from '../packages/shared-domain/src/dailyBudgetWarningStrings';

describe('dailyBudgetWarningStrings', () => {
  it('titles the warning around the hard cap, not an "hourly limit"', () => {
    expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE).toBe(
      'Daily budget exceeds what your hard cap can deliver',
    );
    expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE).not.toMatch(/hourly/i);
  });

  it('uses "hard cap" in both body branches and never "hourly (power )?limit"', () => {
    const withCeiling = formatDailyBudgetAllocationWarningBody('60.0 kWh', '48.0 kWh');
    const withoutCeiling = formatDailyBudgetAllocationWarningBody('60.0 kWh', null);
    for (const text of [withCeiling, withoutCeiling]) {
      expect(text).toContain('hard cap');
      expect(text).not.toMatch(/hourly/i);
    }
  });

  it('recommends lowering the daily budget — never raising the hard cap', () => {
    const withCeiling = formatDailyBudgetAllocationWarningBody('60.0 kWh', '48.0 kWh');
    const withoutCeiling = formatDailyBudgetAllocationWarningBody('60.0 kWh', null);
    for (const text of [withCeiling, withoutCeiling]) {
      // Hard cap is physical — copy must never suggest raising it as a remedy.
      expect(text).not.toMatch(/raise.*hard cap|increase.*hard cap|raise.*cap|increase.*cap/i);
      expect(text.toLowerCase()).toContain('lower the daily budget');
    }
  });

  it('quotes both the configured and ceiling values when a ceiling is known', () => {
    const text = formatDailyBudgetAllocationWarningBody('60.0 kWh', '48.0 kWh');
    expect(text).toContain('60.0 kWh');
    expect(text).toContain('48.0 kWh');
  });

  it('falls back to a generic body when no ceiling is provided', () => {
    const text = formatDailyBudgetAllocationWarningBody('60.0 kWh', null);
    expect(text).toContain('60.0 kWh');
    expect(text).not.toContain('48.0');
  });
});
