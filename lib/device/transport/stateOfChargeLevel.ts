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
  // Percent only, deliberately, even though the known arm also carries
  // `observedAtMs`: this asks whether the ANSWER moved, and a level re-stamped at
  // the same percentage says the same thing. Callers that care about the stamp
  // compare `report.observedAtMs` themselves, and both of them do.
  // The car's ceiling is part of the answer: a limit that qualifies, moves or is
  // disproved changes what a smart task can reach.
  if (previous.kind === 'known' && next.kind === 'known') {
    return previous.percent !== next.percent || previous.carChargeLimitPercent !== next.carChargeLimitPercent;
  }
  if (previous.kind === 'unavailable' && next.kind === 'unavailable') {
    return previous.reasonCode !== next.reasonCode;
  }
  return false;
};
