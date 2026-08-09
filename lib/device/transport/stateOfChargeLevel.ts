import type { DeviceStateOfChargeSnapshot } from '../../../packages/contracts/src/types';

type StateOfChargeLevel = DeviceStateOfChargeSnapshot['level'];

/**
 * Whether two resolved levels say different things.
 *
 * A leaf of its own so both the parse path (`stateOfCharge.ts`) and the
 * car-adoption write (`carStateOfChargeWrite.ts`) can compare levels without one
 * importing the other — they already point the other way.
 *
 * This is change detection over producer output, not re-resolution: the caller
 * asks "did the answer move" so it can skip a dispatch, and never re-derives the
 * answer itself.
 */
export const stateOfChargeLevelsDiffer = (
  previous: StateOfChargeLevel | undefined,
  next: StateOfChargeLevel,
): boolean => {
  if (previous === undefined || previous.kind !== next.kind) return true;
  if (previous.kind === 'known' && next.kind === 'known') return previous.percent !== next.percent;
  if (previous.kind === 'unavailable' && next.kind === 'unavailable') {
    return previous.reasonCode !== next.reasonCode;
  }
  return false;
};
