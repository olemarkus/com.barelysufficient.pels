/** The main home's independent EV-task discharge hold lane. It grants no capacity relief. */
export type EvDischargeHoldLane = {
  hasWork(hold: boolean): boolean;
  /** Accepts a newly decided intent without waiting for cloud I/O. */
  apply(hold: boolean, canHold: () => boolean): void;
};
