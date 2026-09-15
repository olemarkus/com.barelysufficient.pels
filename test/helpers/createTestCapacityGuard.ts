import CapacityGuard, { type CapacityGuardOptions } from '../../lib/power/capacityGuard';
import type { PlanInputCapacityStateSummary } from '../../lib/power/capacityStateSummary';

/**
 * Constructs a `CapacityGuard` for tests that do not assert on its structured
 * logs.
 *
 * `structuredLog` is required on the production type on purpose: both factories
 * always inject the home-attributed `capacity` logger, and a default inside the
 * guard would silently drop the `homeId` correlation every incident log depends
 * on. Tests that *do* assert on logging pass their own spy through here; the
 * rest get a sink, so the requirement stays honest in production without
 * forcing a logger into every fixture.
 */
export function createTestCapacityGuard(
  options: Omit<CapacityGuardOptions, 'structuredLog'>
    & Partial<Pick<CapacityGuardOptions, 'structuredLog'>>,
): CapacityGuard {
  return new CapacityGuard({
    ...options,
    structuredLog: options.structuredLog ?? { info: () => undefined },
  });
}

/**
 * The capacity state a plan verdict carries, as production composes it in
 * `reportShortfallToGuard`. Guard specs that are not about the record's contents say
 * only whether the build's shed candidates could still relieve anything.
 */
export function planVerdictSummaryFixture(
  verdict: { actionableLoadRemains: boolean; shedReliefInFlight?: boolean },
): PlanInputCapacityStateSummary {
  const remainingActionableControlledLoadW = verdict.actionableLoadRemains ? 1000 : 0;
  return {
    controlledDevices: 0,
    plannedShedDevices: 0,
    pendingPlannedShedDevices: 0,
    activePlannedShedDevices: 0,
    activeControlledDevices: 0,
    zeroDrawControlledDevices: 0,
    pendingControlledDevices: 0,
    actuationInFlight: false,
    controlledPowerW: 0,
    uncontrolledPowerW: 0,
    remainingReducibleControlledLoadW: remainingActionableControlledLoadW,
    remainingReducibleControlledLoad: verdict.actionableLoadRemains,
    remainingActionableControlledLoadW,
    remainingActionableControlledLoad: verdict.actionableLoadRemains,
    shedReliefInFlight: verdict.shedReliefInFlight ?? false,
    summarySource: 'plan_input',
    summarySourceAtMs: 0,
  };
}
