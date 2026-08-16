import type { PlanContext } from '../../lib/plan/planContext';

/**
 * The power members of a `PlanContext`, built the way `lib/power` builds them.
 *
 * Fixtures used to set `total` / `planningTotalKw` / `powerFreshnessState`
 * directly, which let a test describe a home that no producer can produce (a
 * total with no sample, a `fresh` label with no reading). Since the planner
 * receives answers rather than ingredients, a fixture states the one thing that
 * is actually true — what the meter read, or that it read nothing — and the
 * answers follow from it exactly as they do in production.
 */
export const planContextPower = (
  totalKw: number | null,
  options: { measured?: boolean; failClosed?: boolean } = {},
): Pick<PlanContext, 'headroomForLimitKw' | 'powerIsMeasured' | 'powerMeasuredAtOrBelowKw'> => {
  const measured = options.measured ?? (typeof totalKw === 'number' && Number.isFinite(totalKw));
  const synthesized = options.failClosed === true ? -1 : 0;
  return {
    headroomForLimitKw: (limitKw: number): number => (
      measured && totalKw !== null ? limitKw - totalKw : synthesized
    ),
    powerIsMeasured: measured,
    powerMeasuredAtOrBelowKw: (limitKw: number): boolean => (
      measured && totalKw !== null && totalKw <= limitKw
    ),
  };
};
