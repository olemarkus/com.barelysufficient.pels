import type { BudgetDailyHistory, BudgetDecisionHistory } from '../../packages/contracts/src/budgetDiagnostics';
import { isUnknownRecord } from '../utils/types';

type BudgetHistoryHost = {
  getBudgetDailyHistory(query: unknown): BudgetDailyHistory;
  getBudgetDecisionHistory(query: unknown): BudgetDecisionHistory;
};

function requireHost(port: { app: unknown }): BudgetHistoryHost {
  const app = port.app;
  if (!isUnknownRecord(app)
    || typeof app.getBudgetDailyHistory !== 'function'
    || typeof app.getBudgetDecisionHistory !== 'function') {
    throw new Error('Budget history is unavailable during startup');
  }
  return app as BudgetHistoryHost;
}

export function getBudgetDailyHistoryFromHomey(port: { app: unknown }, query: unknown): BudgetDailyHistory {
  return requireHost(port).getBudgetDailyHistory(query);
}

export function getBudgetDecisionHistoryFromHomey(port: { app: unknown }, query: unknown): BudgetDecisionHistory {
  return requireHost(port).getBudgetDecisionHistory(query);
}
