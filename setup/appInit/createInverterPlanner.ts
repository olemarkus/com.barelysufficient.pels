import type { AppContext } from '../../lib/app/appContext';
import { InverterCurtailmentPlanner } from '../../lib/plan/inverterCurtailment';
import { readInverterPlanInputs } from '../../lib/planInput/inverterPlanInput';
import type { InverterControlPolicy, InverterExecutionRead, InverterPlanner } from '../../lib/ports/inverterControl';
import { requireHomeMembership, requirePriceCoordinator } from './contextGuards';

/** Bind owner reads to the integration projection, then to the pure planner. */
export function createInverterPlanner(
  ctx: AppContext, policy: InverterControlPolicy, execution: InverterExecutionRead, simulation: () => boolean,
): InverterPlanner {
  const source = {
    configurations: () => ctx.deviceConfiguration.getAll(),
    observed: (id: string) => ctx.observer.getObservedRecord(id),
    selected: () => policy.read(),
    membership: () => requireHomeMembership(ctx),
    simulation,
    execution,
  };
  return new InverterCurtailmentPlanner({
    inputs: () => readInverterPlanInputs(source),
    exportCostly: (nowMs) => requirePriceCoordinator(ctx).isExportCostly(nowMs),
  });
}
