/** The configured source for the whole-home power signal. */
export type PowerSource = 'homey_energy' | 'flow';

/** Persisted-setting failures the power-source reader can classify. */
export type PowerSourceSettingSuspectReason =
  | 'missing_existing_key'
  | 'empty_key_list';

/** Power-source settings after the owning boundary has classified the read. */
export type ConfiguredPowerSourceRead =
  | { state: 'resolved'; value: PowerSource }
  | {
    state: 'suspect';
    reason: PowerSourceSettingSuspectReason | 'read_failed';
    error: Error;
  };
