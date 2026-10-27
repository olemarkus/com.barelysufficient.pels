import type { AppContext } from '../../lib/app/appContext';
import {
  NO_INVERTER_EXECUTION, NO_INVERTER_PLANNER,
  type InverterActuation, type InverterExecution, type InverterPlanner,
} from '../../lib/ports/inverterControl';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import type { HomeScope } from './homeScope';
import { createInverterControlPolicy } from '../appInit/createInverterControlPolicy';
import { createInverterExecutor } from '../appInit/createInverterExecutor';
import { createInverterPlanner } from '../appInit/createInverterPlanner';

/** Main's price-driven inverter lane; meter areas remain capacity-only. */
export function createInverterCurtailment(
  ctx: AppContext, scope: HomeScope, actuator: InverterActuation,
): { planner: InverterPlanner; executor: InverterExecution } {
  if (scope.homeId !== MAIN_HOME_ID) return { planner: NO_INVERTER_PLANNER, executor: NO_INVERTER_EXECUTION };
  const policy = createInverterControlPolicy(ctx);
  const executor = createInverterExecutor(ctx, actuator, policy, scope.readSimulationSetting);
  return { executor, planner: createInverterPlanner(ctx, policy, executor, scope.readSimulationSetting) };
}
