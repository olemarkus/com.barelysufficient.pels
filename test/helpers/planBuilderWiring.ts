import { NO_INVERTER_PLANNER } from '../../lib/ports/inverterControl';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { decorateWithoutDeferredObjectives } from '../../lib/plan/planBuilderDecoration';
import type { PlanBuilderDeps } from '../../lib/plan/planBuilderDeps';
import { fixtureTemperatureSetpoints } from './temperatureSetpointsFixture';
import { testLogger } from '../utils/testLogger';
import { noDrawEvidence } from './observedDeviceReadsDouble';

type PlanBuilderWiring = Omit<PlanBuilderDeps,
  | 'capacityGuard'
  | 'getCapacitySettings'
  | 'getPowerTracker'
  | 'deviceDiagnostics'>;

/**
 * The `PlanBuilder` deps a spec is not about: not in shortfall, no dry run, no
 * surplus inferred, a release leaves the device free, no price optimization, no
 * daily budget, shed by turning off, no binary command
 * in flight, no smart tasks, and the ordinary setpoint reads. A spec supplies
 * the guard, capacity settings and power tracker, and overrides the rest.
 */
export const planBuilderWiring = (): PlanBuilderWiring => ({
  getCapacityDryRun: () => false,
  getMainFuse: () => ({ kind: 'off' }),
  getInferredSurplusKw: () => 0,
  getStorageDischargeObservations: () => new Map(),
  inverterCurtailment: NO_INVERTER_PLANNER,
  leaveOffOnRelease: () => 'released',
  getPriceOptimizationSettings: () => ({}),
  getDailyBudgetSnapshot: () => null,
  getShedBehavior: () => ({ action: 'turn_off' }),
  drawEvidence: noDrawEvidence,
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  decorateDeferredObjectives: decorateWithoutDeferredObjectives,
  resolveTemperatureSetpoints: fixtureTemperatureSetpoints(),
  structuredLog: testLogger,
});
