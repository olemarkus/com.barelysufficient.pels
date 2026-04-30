import type { PlanResult } from './dailyBudgetManagerTypes';

export function logUncontrolledReserveDebug(params: {
  plan: PlanResult;
  structuredDebug?: (payload: Record<string, unknown>) => void;
}): void {
  const { plan, structuredDebug } = params;
  const diagnostics = plan.uncontrolledReserveDiagnostics;
  if (!plan.shouldLog || !diagnostics) return;
  structuredDebug?.({
    component: 'daily_budget',
    event: 'uncontrolled_reserve_plan',
    mode: 'balanced',
    totalReservedKWh: diagnostics.totalReservedKWh,
    avgQuantile: diagnostics.averageQuantile,
    lowConfidenceHours: diagnostics.lowConfidenceHours,
    volatileHours: diagnostics.volatileHours,
    strictBudgetProtection: false,
  });
}
