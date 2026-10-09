import { vi } from 'vitest';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import type { PlanBuilderDeps } from '../../lib/plan/planBuilderDeps';
import { fixtureTemperatureSetpoints } from './temperatureSetpointsFixture';

type PlanBuilderWiring = Omit<PlanBuilderDeps,
  | 'capacityGuard'
  | 'getCapacitySettings'
  | 'getPowerTracker'
  | 'deviceDiagnostics'
  | 'structuredLog'
  | 'debugStructured'>;

/**
 * The `PlanBuilder` deps a spec is not about: not in shortfall, no dry run, no
 * surplus inferred, a release leaves the device free, no price optimization, no
 * daily budget, shed by turning off, no soft-limit override, no binary command
 * in flight, no smart tasks, and the ordinary setpoint reads. A spec supplies
 * the guard, capacity settings and power tracker, and overrides the rest.
 */
export const planBuilderWiring = (): PlanBuilderWiring => ({
  setCapacityInShortfall: vi.fn(),
  getCapacityDryRun: () => false,
  getInferredSurplusKw: () => 0,
  leaveOffOnRelease: () => 'released',
  getPriceOptimizationSettings: () => ({}),
  getDailyBudgetSnapshot: () => null,
  getShedBehavior: () => ({ action: 'turn_off' }),
  getDynamicSoftLimitOverride: () => null,
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  resolveTemperatureSetpoints: fixtureTemperatureSetpoints(),
  log: vi.fn(),
});
