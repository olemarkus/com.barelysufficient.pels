import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { PhaseFootprint } from '../../../packages/planner-types/src/phaseFootprint';
import { floorStorageSetpointW } from '../../utils/storageSetpoint';
import { phaseRoomFor, spendPhaseRoom, type PhaseRoomAxis } from '../phase/phaseRoom';

/**
 * A battery charge within its phases (`notes/main-fuse.md`). A charge on a
 * known phase rises only into what its phases have left this cycle, and spends
 * it, so batteries sharing a phase do not each take the same room. A battery
 * on an unknown phase is not bounded: bounding it by the lowest phase would
 * stop it storing solar. A discharge, or any setpoint while phases are not
 * protected, passes unchanged.
 */
export function chargeWithinPhaseRoom(
  axis: PhaseRoomAxis,
  storage: ObservedStorageInput,
  footprint: PhaseFootprint,
  setpointW: number,
): { setpointW: number; axis: PhaseRoomAxis } {
  if (setpointW <= 0 || axis.kind === 'off') return { setpointW, axis };
  if (footprint.kind !== 'single' && footprint.kind !== 'all_three') return { setpointW, axis };
  const room = phaseRoomFor(axis, footprint);
  if (room.kind === 'off') return { setpointW, axis };
  const allowedW = Math.max(0, storage.signedPowerW + Math.max(0, room.kw * 1000));
  const boundedW = setpointW > allowedW ? floorStorageSetpointW(allowedW, storage.range) : setpointW;
  const addedW = Math.max(0, boundedW - Math.max(0, storage.signedPowerW));
  return { setpointW: boundedW, axis: spendPhaseRoom(axis, footprint, addedW / 1000) };
}
