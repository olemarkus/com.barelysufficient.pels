/** Per-battery discharge debit, independent of permission to control it. */
export type StorageDischargeObservation = {
  dischargeW: number;
  /** Only an available observation can replace an existing held-discharge reservation. */
  heldDischarge: 'releasable' | 'reserved';
};
