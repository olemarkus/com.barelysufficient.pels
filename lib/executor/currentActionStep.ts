import type {
  DeviceControlAdapterSnapshot, MeasuredPowerObservedProbe, SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import { getSteppedLoadStep } from '../../packages/shared-domain/src/deviceControlProfiles';
import type { SteppedLoadDesiredRuntimeState } from './steppedCommandState';

/** A setting the charger accepted in this control session, usable as a planning bound. */
export function resolveCurrentActionStep(
  command: Pick<SteppedLoadDesiredRuntimeState, 'stepId' | 'status' | 'currentActionReceipt'> | undefined,
  control: DeviceControlAdapterSnapshot | undefined,
  profile: SteppedLoadProfile,
  power: MeasuredPowerObservedProbe | undefined,
): string | undefined {
  const receipt = command?.currentActionReceipt;
  if (!receipt || command.status !== 'success' || control?.currentActionEpoch !== receipt.epoch) return undefined;
  const step = getSteppedLoadStep(profile, command.stepId);
  if (!step || step.planningPowerW !== receipt.planningPowerW) return undefined;
  // Nominal ladder watts allow for reasonable voltage variation. Only later draw can contradict the write.
  if (power?.measuredPowerKw !== undefined && power.measuredPowerObservedAtMs !== undefined
    && power.measuredPowerObservedAtMs > receipt.acknowledgedAtMs
    && power.measuredPowerKw * 1000 > step.planningPowerW * 1.1) return undefined;
  return step.id;
}
