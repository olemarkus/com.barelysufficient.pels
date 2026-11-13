import { ChargingPhaseControlOwner } from '../../lib/chargingPhases/chargingPhaseControlOwner';
import type {
  ChargingPhaseOwner, ChargingPhaseActuation, ChargingPhasePauseRecording,
} from '../../lib/ports/chargingPhases';
import { ExecutionOnlyChargingPhases } from '../../lib/chargingPhases/executionOnlyChargingPhases';
import { MainHomeChargingPhaseSource } from '../../lib/home/chargingPhaseScope';
import type { ControlContestRecording } from '../../lib/ports/controlContest';
import type { AppContext } from '../../lib/app/appContext';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import type { HomeScope } from './homeScope';
import { requireDeviceManager, requireHomeMembership, requirePlanService } from '../appInit/contextGuards';

/** Construct one owner, alongside Main's engine; meter areas never share its durable claims. */
export function createChargingPhaseControl(
  ctx: AppContext, scope: HomeScope, actuation: ChargingPhaseActuation, contests: ControlContestRecording,
  pauses: ChargingPhasePauseRecording,
): ChargingPhaseOwner {
  // Registry construction follows Main's plan stack startup. Share its existing
  // execution gate; areas must never construct another durable phase owner.
  if (scope.homeId !== MAIN_HOME_ID) {
    return new ExecutionOnlyChargingPhases(requirePlanService(ctx).readChargingPhaseExecutionGate());
  }
  const transport = requireDeviceManager(ctx);
  const source = new MainHomeChargingPhaseSource({
    readDevices: transport.readChargingPhaseDevices.bind(transport),
    envelopes: transport.readChargingPhaseEnvelopes.bind(transport),
    observedPoint: transport.readChargingPhasePoint.bind(transport),
    releasePlanningEnvelope: transport.resetChargingPhaseEnvelope.bind(transport),
    isSimulation: scope.getCapacityDryRun,
  }, requireHomeMembership(ctx));
  return new ChargingPhaseControlOwner(ctx.homey.settings, source, actuation, contests, pauses);
}
