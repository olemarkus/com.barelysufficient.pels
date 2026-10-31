import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageShedTerm } from '../shedding/types';

/**
 * Why the plan holds a battery this cycle, for the state log and the
 * overview: `relief`, a limit hold discharging to hold the limit;
 * `charge_limit`, a limit hold capping its charge (0 W included);
 * `cap_for_device`, a surplus hold keeping its charge below what its own mode
 * charged so a device ranked above it gets that power; `raise_charge`, a
 * surplus hold charging past that from what its offer leaves; on a battery
 * plan, `plan_supply` (discharging to the house), `plan_wait` (holding at
 * 0 W), `plan_solar` (charging to store solar) or `plan_charge` (charging for
 * any other plan reason); or `none` (not held).
 */
export type StorageClaimReason = 'none' | 'relief' | 'charge_limit' | 'cap_for_device' | 'raise_charge'
  | 'plan_charge' | 'plan_solar' | 'plan_supply' | 'plan_wait';

/** One battery as this cycle left it, for the state log. */
export type StorageStateSummary = {
  deviceId: string;
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
  /** Under a charge limit, the charge its own mode would take that the cap holds back, W; else 0. */
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
export type StorageBalance = { deficitW: number; headroomW: number | null; netImportW: number };
