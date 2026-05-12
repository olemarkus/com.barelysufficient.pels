import type { PlanResult } from './dailyBudgetManagerTypes';
import { UNMANAGED_RESERVE_CONSERVATIVE_MODE } from './dailyBudgetConstants';

export function logUncontrolledReserveDebug(params: {
  plan: PlanResult;
  reserveMode: number;
  shouldLog?: boolean;
  structuredDebug?: (payload: Record<string, unknown>) => void;
}): void {
  const { plan, reserveMode, shouldLog = plan.shouldLog, structuredDebug } = params;
  const diagnostics = plan.uncontrolledReserveDiagnostics;
  if (!shouldLog || !diagnostics) return;
  structuredDebug?.({
    component: 'daily_budget',
    event: 'uncontrolled_reserve_plan',
    mode: reserveMode >= UNMANAGED_RESERVE_CONSERVATIVE_MODE ? 'conservative' : 'balanced',
    totalReservedKWh: diagnostics.totalReservedKWh,
    avgQuantile: diagnostics.averageQuantile,
    lowConfidenceHours: diagnostics.lowConfidenceHours,
    volatileHours: diagnostics.volatileHours,
    strictBudgetProtection: false,
  });
}
