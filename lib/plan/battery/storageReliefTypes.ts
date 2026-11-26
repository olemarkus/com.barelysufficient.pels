import type { PhaseName } from '../../../packages/planner-types/src/phaseFootprint';
import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageShedTerm } from '../shedding/types';

/** The capacity, solar or economic reason for the battery's current target. */
export type StorageClaimReason = 'none' | 'relief' | 'charge_limit'
  | 'plan_charge' | 'plan_solar' | 'plan_supply' | 'plan_export' | 'plan_wait';

/** One battery as this cycle left it, for the state log. */
export type StorageStateSummary = {
  deviceId: string;
  /** The hold exists to bring this exporting phase back under its target. */
  exportPhase?: PhaseName;
  reading: 'observed' | 'missing' | 'absent';
  claimHeld: boolean;
  /**
   * Its Power-limit control is off: PELS never takes it over, and its own app
   * is in charge. False for a battery this cycle could not read.
   */
  powerLimitOff: boolean;
  claim: StorageClaimReason;
  /** What the plan carries to the battery this cycle; `none` when it decides nothing for it. */
  decision: StorageDecision | { kind: 'none' };
  /** The signed power this cycle decided to hold, W: negative discharges, positive charges. */
  setpointW: number;
  /** Under a charge limit, the charge the capacity limit holds back, W; else 0. */
  heldBackChargeW: number;
  creditW: number;
  /**
   * What restore and admission may not spend for this battery, W: the
   * discharge PELS holds or is handing back (stored energy, not room), and a
   * charge increase decided this cycle that the measurement does not show yet
   * (`withoutStorageWithheld`).
   */
  withheldW: number;
};

/**
 * What the stage decided this cycle. `batteries` is the one list of what was
 * decided for each battery; its decisions and withheld power are read from it.
 */
export type StorageRelief = {
  /** What shedding counts against the measured deficit. */
  shed: StorageShedTerm;
  /** The stage's holds after this cycle: the next `PlanEngineState.storageLeverByDevice`. */
  levers: Readonly<Record<string, StorageLeverState>>;
  batteries: readonly StorageStateSummary[];
};

/**
 * The headroom still to give back, W, as each battery takes its share; the
 * deficit, which keeps a surplus hold where it is for shedding to decide; and
 * the net import, W, moved by each battery's decided change, against which a
 * battery plan sizes its discharge to the house.
 */
/**
 * The measured cycle the batteries are decided in: the deficit and headroom
 * left so far, the whole-home net import, W, and when the meter took the
 * reading behind them, ms.
 */
export type StorageBalance = { deficitW: number; headroomW: number | null; netImportW: number; sampledAtMs: number };
