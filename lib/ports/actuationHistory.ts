/** One restore's pacing anchor and the command window that its measured draw must follow. */
export type RestoreDrawEvidence = {
  readonly deviceId: string;
  readonly restoredAtMs: number;
  readonly drawEvidenceFromMs: number;
};

/** Facts execution has recorded; planning consumes these without mutation authority. */
export type ActuationHistoryRead = {
  readonly lastDeviceControlledMs: Readonly<Record<string, number>>;
  readonly lastDeviceShedMs: Readonly<Record<string, number>>;
  readonly lastDeviceRestoreMs: Readonly<Record<string, number>>;
  readRestoreDrawEvidence(): readonly RestoreDrawEvidence[];
  readonly lastRestoreMs: number | null;
  hasInFlight(): boolean;
};

/** The persistence owner can hydrate clocks, including a late legacy import. */
export type ActuationHydration = Pick<ActuationHistoryRead, 'lastDeviceControlledMs'> & {
  loadLastControlled(stored: Readonly<Record<string, number>>): void;
};
