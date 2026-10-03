import type { BudgetAdviceDecision } from '../../packages/contracts/src/budgetDiagnostics';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { getLogger } from '../logging/logger';
import { isUnknownRecord } from '../utils/types';

const logger = getLogger('weather/budget-advice-history');
const MAX_DECISIONS = 730;

export type BudgetAdviceHistoryStore = {
  record(decision: BudgetAdviceDecision): void;
  read(): BudgetAdviceDecision[];
};

const numericFields = [
  'recordedAtMs', 'suggestedBudgetKwh', 'predictedKwh', 'predictedLowKwh', 'predictedHighKwh',
  'forecastMeanTempC', 'computedAtMs', 'pressureAccumulatorKwh', 'pressureContributionKwh',
] as const;
const nullableNumericFields = [
  'budgetBeforeKwh', 'budgetAfterKwh', 'modelPseudoR2', 'modelUsableDays', 'sustainableDailyCeilingKwh',
] as const;
const outcomes = ['applied', 'auto_apply_off', 'would_lower_while_limiting', 'budget_disabled_or_unavailable'];
const isAlgorithmVersion = (value: unknown): boolean => value === undefined || value === 2;
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A damaged journal row never becomes apparently valid prediction evidence. */
function parseDecision(json: string): BudgetAdviceDecision | null {
  let raw: unknown;
  try { raw = JSON.parse(json) as unknown; } catch { return null; }
  if (!isUnknownRecord(raw)) return null;
  if (!isAlgorithmVersion(raw.budgetAlgorithmVersion)) return null;
  if (!numericFields.every((key) => isFinite(raw[key]))) return null;
  if (!nullableNumericFields.every((key) => raw[key] === null || isFinite(raw[key]))) return null;
  if (typeof raw.targetDateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.targetDateKey)) return null;
  if (!isNullableString(raw.pressureThroughDateKey)) return null;
  if (!isNullableString(raw.meterScopeSignature)) return null;
  if (typeof raw.outcome !== 'string' || !outcomes.includes(raw.outcome)) return null;
  if (raw.forecastSource !== 'met_api' && raw.forecastSource !== 'recent_days') return null;
  if (!['beyondObservedCold', 'beyondObservedWarm', 'budgetMayBeLimiting']
    .every((key) => typeof raw[key] === 'boolean')) return null;
  return raw as BudgetAdviceDecision;
}

export function createBudgetAdviceHistoryStore(db: UserdataDatabase): BudgetAdviceHistoryStore {
  db.exec(`CREATE TABLE IF NOT EXISTS budget_advice_decisions (
    sequence INTEGER PRIMARY KEY, decision_json TEXT NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO budget_advice_decisions (decision_json) VALUES (?)');
  const prune = db.prepare('DELETE FROM budget_advice_decisions WHERE sequence NOT IN '
    + '(SELECT sequence FROM budget_advice_decisions ORDER BY sequence DESC LIMIT ?)');
  const load = db.prepare('SELECT sequence, decision_json FROM budget_advice_decisions ORDER BY sequence');
  return {
    record: (decision) => db.transaction(() => {
      insert.run(JSON.stringify(decision));
      prune.run(MAX_DECISIONS);
    }),
    read: () => (load.all() as Array<{ sequence: number; decision_json: string }>).flatMap((row) => {
      const decision = parseDecision(row.decision_json);
      if (decision !== null) return [decision];
      logger.warn({ event: 'budget_advice_history_row_unreadable', sequence: row.sequence });
      return [];
    }),
  };
}
