import {
  DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT,
  formatDailyBudgetAllocationWarningBody,
} from '../../packages/shared-domain/src/dailyBudgetWarningStrings';

describe('dailyBudgetWarningStrings', () => {
  it('titles the warning around the hard cap, not an "hourly limit"', () => {
    expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT.capacity).toBe(
      'Daily budget exceeds what your hard cap can deliver',
    );
    expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT.capacity).not.toMatch(/hourly/i);
  });

  it('titles the warning around the grid import limit when that limit sets the ceiling', () => {
    expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT.grid).toBe(
      'Daily budget exceeds what your grid import limit can deliver',
    );
    expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT.grid).not.toMatch(/hard cap/i);
  });

  it('uses "hard cap" in both body branches and never "hourly (power )?limit"', () => {
    const withCeiling = formatDailyBudgetAllocationWarningBody('capacity', '60.0 kWh', '48.0 kWh');
    const withoutCeiling = formatDailyBudgetAllocationWarningBody('capacity', '60.0 kWh', null);
    for (const text of [withCeiling, withoutCeiling]) {
      expect(text).toContain('hard cap');
      expect(text).not.toMatch(/hourly/i);
    }
  });

  it('names the grid import limit, never the hard cap, in both grid body branches', () => {
    const withCeiling = formatDailyBudgetAllocationWarningBody('grid', '200.0 kWh', '168.0 kWh');
    const withoutCeiling = formatDailyBudgetAllocationWarningBody('grid', '200.0 kWh', null);
    for (const text of [withCeiling, withoutCeiling]) {
      expect(text).toContain('grid import limit');
      expect(text).not.toMatch(/hard cap|hourly/i);
    }
  });

  it('recommends lowering the daily budget — never raising the limit', () => {
    for (const limit of ['capacity', 'grid'] as const) {
      const withCeiling = formatDailyBudgetAllocationWarningBody(limit, '60.0 kWh', '48.0 kWh');
      const withoutCeiling = formatDailyBudgetAllocationWarningBody(limit, '60.0 kWh', null);
      for (const text of [withCeiling, withoutCeiling]) {
        // Hard cap is an hourly ceiling — copy must never suggest raising it as a remedy.
        expect(text).not.toMatch(/raise.*hard cap|increase.*hard cap|raise.*cap|increase.*cap|raise.*limit/i);
        expect(text.toLowerCase()).toContain('lower the daily budget');
      }
    }
  });

  it('quotes both the configured and ceiling values when a ceiling is known', () => {
    const text = formatDailyBudgetAllocationWarningBody('capacity', '60.0 kWh', '48.0 kWh');
    expect(text).toContain('60.0 kWh');
    expect(text).toContain('48.0 kWh');
  });

  it('falls back to a generic body when no ceiling is provided', () => {
    const text = formatDailyBudgetAllocationWarningBody('capacity', '60.0 kWh', null);
    expect(text).toContain('60.0 kWh');
    expect(text).not.toContain('48.0');
  });

  it('uses no em-dashes in any branch', () => {
    for (const limit of ['capacity', 'grid'] as const) {
      expect(DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT[limit]).not.toContain('—');
      expect(formatDailyBudgetAllocationWarningBody(limit, '60.0 kWh', '48.0 kWh')).not.toContain('—');
      expect(formatDailyBudgetAllocationWarningBody(limit, '60.0 kWh', null)).not.toContain('—');
    }
  });
});
