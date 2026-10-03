import { readBudgetHistoryRange } from '../../lib/weather/budgetDiagnosticsHistory';
import {
  getBudgetDailyHistoryFromHomey, getBudgetDecisionHistoryFromHomey,
} from '../../lib/weather/budgetDiagnosticsApi';

describe('budget diagnostics transport boundary', () => {
  it('accepts inclusive local dates including leap days and DST dates', () => {
    expect(readBudgetHistoryRange({ from: '2024-01-01', to: '2024-12-31' }))
      .toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(readBudgetHistoryRange({ from: '2026-10-25', to: '2026-10-25' }))
      .toEqual({ from: '2026-10-25', to: '2026-10-25' });
  });

  it.each([
    undefined, {}, { from: ['2026-01-01'], to: '2026-01-02' },
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-01-02', to: '2026-01-01' },
    { from: '2024-01-01', to: '2025-01-01' },
    { from: '2026-01-01T00:00:00Z', to: '2026-01-02' },
    { from: '2026-01-01', to: '2026-01-02', homeId: 'other' },
  ])('rejects invalid or misleading queries: %j', (query) => {
    expect(() => readBudgetHistoryRange(query)).toThrow();
  });

  it('passes the query through the host seam and refuses an unwired startup', () => {
    const days = { records: ['daily sentinel'] };
    const decisions = { records: ['decision sentinel'] };
    const port = { app: {
      getBudgetDailyHistory: vi.fn(() => days),
      getBudgetDecisionHistory: vi.fn(() => decisions),
    } };
    const query = { from: '2026-10-01', to: '2026-10-02' };
    expect(getBudgetDailyHistoryFromHomey(port, query)).toBe(days);
    expect(getBudgetDecisionHistoryFromHomey(port, query)).toBe(decisions);
    expect(port.app.getBudgetDailyHistory).toHaveBeenCalledWith(query);
    expect(() => getBudgetDailyHistoryFromHomey({ app: {} }, query)).toThrow('startup');
  });
});
