import type { PlannedDeviceCommands } from '../planContract/executionPlan';
import { hasPlannedStep } from '../planContract/executionPlan';
import { hasBinaryCommand } from './executablePlan';
import type { ExecutableObservedDeviceState } from './executablePlan';
import type { ChargingPhaseExecutor } from './chargingPhaseExecutor';
import type { ChargingPhaseDecision } from '../planContract/chargingPhaseDecision';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isBinaryDrivenIntent } from './executableDesiredState';

/** Execution follows the already-decided direction; a phase transition never blocks safety reductions. */
const isReduction = (intent: PlannedDeviceCommands, observed: ExecutableObservedDeviceState | undefined): boolean => {
  if (hasBinaryCommand(intent) && !intent.binary.desiredOn) return observed?.observedEffectiveOn !== false;
  if (!hasPlannedStep(intent)) return false;
  if (intent.steppedLoad.desired.stepId === observed?.steppedLoad?.reportedStepId) return false;
  const transition = intent.steppedLoad.transition?.effectiveTransition;
  return transition === 'step_down_while_on' || transition === 'full_shed_to_off';
};

/** One device's ordinary command sequence shares the physical phase owner's queue. */
export function withChargingPhaseControl<T>(
  phases: ChargingPhaseExecutor,
  intent: PlannedDeviceCommands,
  observed: ExecutableObservedDeviceState | undefined,
  phaseIntent: ChargingPhaseDecision | undefined,
  operation: () => Promise<T>,
  skipped: T,
): Promise<T> {
  if (!phases.handlesDevice(intent.id)) return operation();
  const reducing = isReduction(intent, observed);
  // PREPARE owns this exact lowering and must persist its reservation first.
  // A real off, or a further current reduction, remains an independent safety command.
  if (phaseIntent?.kind === 'prepare' && hasPlannedStep(intent)
    && !(isBinaryDrivenIntent(intent.steppedLoad) && !intent.steppedLoad.desiredOn)
    && getSteppedLoadStep(intent.steppedLoad.steppedLoadProfile, intent.steppedLoad.desired.stepId)
      ?.planningCurrentA === phaseIntent.target.currentA) return Promise.resolve(skipped);
  if (reducing) phases.cancelForSafety(intent.id);
  if (!reducing && (phaseIntent !== undefined || phases.blocksIncrease(intent.id))) return Promise.resolve(skipped);
  return phases.runDeviceCommand(intent.id, operation);
}
