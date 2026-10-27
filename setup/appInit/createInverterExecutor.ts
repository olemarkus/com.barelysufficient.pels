import type { AppContext } from '../../lib/app/appContext';
import { InverterClaimStore } from '../../lib/executor/inverterClaimStore';
import { InverterExecutor } from '../../lib/executor/inverterExecutor';
import type { InverterActuation, InverterControlPolicy } from '../../lib/ports/inverterControl';

/** The executor owns durable hand-back and convergence; setup binds its ports. */
export function createInverterExecutor(
  ctx: AppContext, actuator: InverterActuation, policy: InverterControlPolicy, simulation: () => boolean,
): InverterExecutor {
  return new InverterExecutor(new InverterClaimStore(ctx.homey.settings), actuator, {
    observation: (id) => ctx.observer.getObservedRecord(id)?.inverterObservation,
    simulation,
    canLimit: (id) => policy.isEnabled(id),
    onExternalControl: (id) => policy.disable(id),
  });
}
