import { buildDeyeDischargeLimitActuator } from './buildDeviceActuator';
import { DeyeDischargeHold } from '../../lib/executor/deyeDischargeHold';
import type { EvDischargeHoldLane } from '../../lib/ports/evDischargeHold';
import type { AppContext } from '../../lib/app/appContext';

export const createDeyeDischargeHold = (settings: AppContext['homey']['settings']): DeyeDischargeHold => (
  new DeyeDischargeHold(settings, buildDeyeDischargeLimitActuator())
);

export type MainDischargeHold = EvDischargeHoldLane & { start(): void; stop(): void };

export function bindMainDischargeHold(
  lane: MainDischargeHold | undefined,
  isPlanFenced: () => boolean,
  hasLiveMeter: () => boolean,
): EvDischargeHoldLane | undefined {
  if (!lane) return undefined;
  return {
    hasWork: (hold) => (!hold || !isPlanFenced()) && lane.hasWork(hold),
    apply: (hold, canHold) => {
      if (hold && isPlanFenced()) return;
      // The accepted intent outlives the reconcile that produced it. Keep its
      // authorization live between reconciles and through the cloud request.
      lane.apply(hold, () => canHold() && hasLiveMeter());
    },
  };
}
