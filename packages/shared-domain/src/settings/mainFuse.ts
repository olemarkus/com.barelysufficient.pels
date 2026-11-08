import type { MainFuse, MainFuseSupply } from '../../../contracts/src/capacitySettings';
import { isFiniteNumber } from '../numberGuards';
import type { PowerLimitControlRead } from './powerLimits';

const NOMINAL_PHASE_VOLTAGE_V = 230;
const MIN_MAIN_FUSE_AMPS = 6;
const MAX_MAIN_FUSE_AMPS = 250;
export const MAIN_FUSE_OFF = 'off';

const WIRE_FACTOR: Record<MainFuseSupply, number> = {
  one_phase: 1,
  three_phase_neutral: 3,
  // Three wires at 230 V between them: line current flows at sqrt(3) x 230 V.
  three_phase_no_neutral: Math.sqrt(3),
};

export const isMainFuseSupply = (value: unknown): value is MainFuseSupply => (
  value === 'one_phase' || value === 'three_phase_neutral' || value === 'three_phase_no_neutral'
);

export const isValidMainFuseAmps = (value: unknown): value is number => (
  isFiniteNumber(value) && value >= MIN_MAIN_FUSE_AMPS && value <= MAX_MAIN_FUSE_AMPS
);

/**
 * The main fuse pair, resolved together because a supply is only usable with a
 * valid size. Off keeps whatever size is stored without using it. Malformed is
 * a fact about the read: the reader decides what it means.
 */
export function resolveMainFuseSetting(supply: unknown, amps: unknown): PowerLimitControlRead<MainFuse> {
  if (supply === MAIN_FUSE_OFF) return { state: 'resolved', value: { kind: 'off' } };
  if (!isMainFuseSupply(supply) || !isValidMainFuseAmps(amps)) return { state: 'malformed' };
  return { state: 'resolved', value: { kind: 'on', supply, amps } };
}

/** What the whole connection carries at this fuse, kW. */
export const mainFuseTotalKw = (fuse: Extract<MainFuse, { kind: 'on' }>): number => (
  WIRE_FACTOR[fuse.supply] * NOMINAL_PHASE_VOLTAGE_V * fuse.amps / 1000
);

/**
 * The grid import limit the runtime enforces: the owner's own, the fuse's
 * total, or the lower of the two. The fuse reuses the grid axis, so a total
 * ceiling needs no planner knowledge of fuses.
 */
export function effectiveGridImportLimitKw(ownerLimitKw: number | null, fuse: MainFuse): number | null {
  if (fuse.kind === 'off') return ownerLimitKw;
  const fuseKw = mainFuseTotalKw(fuse);
  return ownerLimitKw === null ? fuseKw : Math.min(ownerLimitKw, fuseKw);
}
