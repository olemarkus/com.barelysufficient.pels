import type {
  BudgetDailyHistory, BudgetDecisionHistory, BudgetHistoryMetadata, BudgetHistoryRange,
} from '../../packages/contracts/src/budgetDiagnostics';
import { isUnknownRecord } from '../utils/types';
import { normalizeWeatherHistoryState } from './weatherHistory';
import type { WeatherHistoryStore } from './weatherHistoryStore';
import type { BudgetAdviceHistoryStore } from './budgetAdviceHistoryStore';

const DAY_MS = 86400000;

function readDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('from and to must be local dates in YYYY-MM-DD format');
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error('from and to must be valid calendar dates');
  }
  return value;
}

/** This API serves the weather owner's whole-home scope; it cannot reinterpret it as a sub-home. */
export function readBudgetHistoryRange(query: unknown): BudgetHistoryRange {
  if (!isUnknownRecord(query)) throw new Error('from and to are required');
  if (query.homeId !== undefined) {
    throw new Error('Budget history uses the whole-home meter scope; homeId is unsupported');
  }
  const from = readDate(query.from);
  const to = readDate(query.to);
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (days < 1 || days > 366) throw new Error('Request an ordered range of at most 366 local dates');
  return { from, to };
}

function buildMetadata(
  requested: BudgetHistoryRange,
  retainedDates: string[],
  meterScopeSignature: string | undefined,
  nowMs: number,
  timeZone: string,
): BudgetHistoryMetadata {
  const dates = [...new Set(retainedDates)].sort();
  const present = new Set(dates);
  const count = (Date.parse(requested.to) - Date.parse(requested.from)) / DAY_MS + 1;
  // UTC arithmetic enumerates civil date labels here, not elapsed hours in the hub's local day.
  const startDateMs = Date.parse(requested.from);
  const missingDates = Array.from({ length: count }, (_, index) => (
    new Date(startDateMs + index * DAY_MS).toISOString().slice(0, 10)
  ))
    .filter((date) => !present.has(date));
  const first = dates[0];
  const last = dates.at(-1);
  return {
    schemaVersion: 1, generatedAtMs: nowMs, timeZone,
    meterScopeSignature: meterScopeSignature ?? null, requested,
    retained: first !== undefined && last !== undefined ? { from: first, to: last } : null,
    missingDates,
  };
}

export function readBudgetDailyHistory(
  store: WeatherHistoryStore, query: unknown, nowMs: number, timeZone: string,
): BudgetDailyHistory {
  const range = readBudgetHistoryRange(query);
  const raw = store.read();
  const state = raw === null ? null : normalizeWeatherHistoryState(raw);
  if (raw !== null && state === null) throw new Error('Budget history is unreadable');
  const records = state?.records ?? [];
  return {
    meta: buildMetadata(range, records.map((record) => record.dateKey), state?.meterScopeSignature, nowMs, timeZone),
    records: records.filter((record) => record.dateKey >= range.from && record.dateKey <= range.to),
    currentBudgetPressure: state?.budgetPressure ?? null,
  };
}

export function readBudgetDecisionHistory(
  store: BudgetAdviceHistoryStore, query: unknown, nowMs: number, timeZone: string,
): BudgetDecisionHistory {
  const range = readBudgetHistoryRange(query);
  const records = store.read();
  return {
    meta: buildMetadata(range, records.map((record) => record.targetDateKey), undefined, nowMs, timeZone),
    records: records.filter((record) => record.targetDateKey >= range.from && record.targetDateKey <= range.to),
  };
}
