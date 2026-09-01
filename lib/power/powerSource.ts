/**
 * The whole-home power signal source the app is configured to use:
 * `homey_energy` polls Homey Energy every 10 s; `flow` is driven by incoming
 * Flow events. Persisted under the `power_source` setting key.
 *
 * `normalizePowerSource` resolves the raw persisted value to the closed union —
 * only the exact string `'homey_energy'` selects Homey Energy; anything else
 * (including unset/garbage) is treated as `flow`, preserving the historical
 * `settings.get('power_source') !== 'homey_energy'` read semantics.
 */
export type PowerSource = 'homey_energy' | 'flow';

export const normalizePowerSource = (value: unknown): PowerSource => (
  value === 'homey_energy' ? 'homey_energy' : 'flow'
);

// There is deliberately NO source→capability predicate here any more.
//
// `deliversProductionSignal` used to sit at this spot, answering "does this
// source carry a whole-home PRODUCTION reading?" with `source === 'homey_energy'`.
// Both quantities are now source-independent: net is delivered signed by both
// sources, and production is read from the same Homey Energy report either way —
// directly on the `homey_energy` poll, and through the companion poll
// (`lib/power/sources/generationPoll.ts`) on `flow`.
//
// Production availability is therefore a RUNTIME fact — "is there a fresh
// generation reading?" (`lib/observer/generationFreshness.ts`) — not a static
// property of the configured source. Resolve it from the reading; do not
// reintroduce a source-name branch to approximate it.

export type PowerSourceSettingSuspectReason =
  | 'missing_existing_key'
  | 'empty_key_list';

export type PowerSourceSettingClassification =
  | { state: 'resolved'; value: PowerSource }
  | {
    state: 'suspect';
    reason: PowerSourceSettingSuspectReason;
  };

/**
 * Pure classification of one persisted `power_source` read plus key-list
 * evidence. Explicit values resolve directly; malformed non-null values keep
 * the historical Flow fallback. An absent value is only the genuine default
 * when a healthy, non-empty key list confirms the source key was never written.
 */
export const classifyPowerSourceSetting = (evidence: {
  raw: unknown;
  keyPresent: boolean;
  keyListEmpty: boolean;
}): PowerSourceSettingClassification => {
  const { raw, keyPresent, keyListEmpty } = evidence;
  if (raw !== undefined && raw !== null) {
    return { state: 'resolved', value: normalizePowerSource(raw) };
  }
  if (keyListEmpty) return { state: 'suspect', reason: 'empty_key_list' };
  if (keyPresent) return { state: 'suspect', reason: 'missing_existing_key' };
  return { state: 'resolved', value: 'flow' };
};

/**
 * The configured power source as a CONSUMER sees it: the classification above
 * plus the error a throwing adapter needs, and the extra `read_failed` reason
 * only an I/O boundary can produce.
 *
 * This is the port type, so it is declared here rather than beside the settings
 * adapter that produces it (`setup/powerSourceSettings.ts`, which re-exports
 * it). A consumer in `lib/` — `PowerMeasurementGate` names the cause of a
 * silent home from it — must be able to name the value without reaching into
 * the wiring layer, which `no-lib-to-setup` forbids in any case.
 */
export type ConfiguredPowerSourceRead =
  | { state: 'resolved'; value: PowerSource }
  | {
    state: 'suspect';
    reason: PowerSourceSettingSuspectReason | 'read_failed';
    error: Error;
  };
