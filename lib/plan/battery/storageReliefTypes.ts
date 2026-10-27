import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageShedTerm } from '../shedding/types';

export type StorageClaimReason = 'none' | 'relief' | 'charge_limit' | 'cap_for_device' | 'raise_charge'
  | 'plan_charge' | 'plan_solar' | 'plan_supply' | 'plan_wait';

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

export type StorageRelief = {
  /** What shedding counts against the measured deficit. */
  shed: StorageShedTerm;
  /** The stage's holds after this cycle: the next `PlanEngineState.storageLeverByDevice`. */
  levers: Readonly<Record<string, StorageLeverState>>;
  batteries: readonly StorageStateSummary[];
};

export type StorageBalance = { deficitW: number; headroomW: number | null; netImportW: number };
