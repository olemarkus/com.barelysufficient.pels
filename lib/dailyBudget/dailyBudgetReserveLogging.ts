import { UNMANAGED_RESERVE_CONSERVATIVE_MODE } from './dailyBudgetConstants';
import type { UncontrolledReservePlanDiagnostics } from './dailyBudgetPlanCaps';

export function logUncontrolledReserveDebug(
  diagnostics: UncontrolledReservePlanDiagnostics,
  reserveMode: number,
  structuredDebug: ((payload: Record<string, unknown>) => void) | undefined,
): void {
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
