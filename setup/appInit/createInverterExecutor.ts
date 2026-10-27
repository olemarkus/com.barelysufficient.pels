import type { AppContext } from '../../lib/app/appContext';
import { InverterClaimStore } from '../../lib/executor/inverterClaimStore';
import { InverterExecutor } from '../../lib/executor/inverterExecutor';
import type { InverterActuation, InverterControlPolicy } from '../../lib/ports/inverterControl';
import { requireDeviceManager } from './contextGuards';

/** The executor owns durable hand-back and convergence; setup binds its ports. */
export function createInverterExecutor(
  ctx: AppContext, actuator: InverterActuation, policy: InverterControlPolicy, simulation: () => boolean,
): InverterExecutor {
  const deviceManager = requireDeviceManager(ctx);
  return new InverterExecutor(new InverterClaimStore(ctx.homey.settings), actuator, {
    exists: (id) => ctx.deviceConfiguration.get(id) !== undefined,
    confirmedRemoved: (id) => deviceManager.isDeviceConfirmedRemoved(id),
    observation: (id) => ctx.observer.getObservedRecord(id)?.inverterObservation,
    control: (id) => ctx.deviceConfiguration.get(id)?.inverterControl,
    simulation,
    canLimit: (id) => policy.isEnabled(id),
    onExternalControl: (id) => policy.disable(id),
  });
}
