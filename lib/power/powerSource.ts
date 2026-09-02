/**
 * The whole-home power signal source the app is configured to use:
 * `homey_energy` polls Homey Energy every 10 s; `flow` is driven by incoming
 * Flow events. Persisted under the `power_source` setting key.
 *
 * `normalizePowerSource` resolves the raw persisted value to the closed union —
 * only the exact string `'homey_energy'` selects Homey Energy; anything else
 * resolves to `flow`. An UNSET key is a lasting state: the runtime never
 * writes a default source. The one runtime write is the boot-time sole-meter
 * adoption (`lib/power/soleMeterAdoption.ts`), which persists the meter and the
 * Power meter source together through the save seam when Homey Energy lists
 * exactly one whole-home meter and no source has been chosen yet; it never
 * writes Flow. Every other install stays unset until the owner chooses a
 * source in Limits & safety, and runs on Flow until then.
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

/** One persisted `power_source` read plus the key-list evidence that classifies its absence. */
export type PowerSourceSettingEvidence = {
  raw: unknown;
  keyPresent: boolean;
  keyListEmpty: boolean;
};

/**
 * Has the owner chosen a source? `chosen` carries what they chose (a
 * malformed non-null value counts as a choice and normalizes to Flow);
 * `unset` is a never-written key proven by a healthy, non-empty key list;
 * `suspect` is absence that cannot be told from a transient read miss. This
 * is the one question `classifyPowerSourceSetting` collapses (unset runs as
 * Flow), asked by the one caller that must not collapse it: the boot-time
 * sole-meter adoption adopts only where nothing was chosen.
 */
export type PowerSourceChoiceClassification =
  | { state: 'chosen'; value: PowerSource }
  | { state: 'unset' }
  | { state: 'suspect'; reason: PowerSourceSettingSuspectReason };

export const classifyPowerSourceChoice = (
  evidence: PowerSourceSettingEvidence,
): PowerSourceChoiceClassification => {
  const { raw, keyPresent, keyListEmpty } = evidence;
  if (raw !== undefined && raw !== null) return { state: 'chosen', value: normalizePowerSource(raw) };
  if (keyListEmpty) return { state: 'suspect', reason: 'empty_key_list' };
  if (keyPresent) return { state: 'suspect', reason: 'missing_existing_key' };
  return { state: 'unset' };
};

/**
 * Pure classification of one persisted `power_source` read plus key-list
 * evidence, as the runtime consumes it: explicit values resolve directly,
 * malformed non-null values resolve to Flow, and a never-written key
 * (`classifyPowerSourceChoice`'s `unset`) resolves to `flow`: an install
 * with no source chosen yet runs on Flow until the owner chooses one.
 */
export const classifyPowerSourceSetting = (
  evidence: PowerSourceSettingEvidence,
): PowerSourceSettingClassification => {
  const choice = classifyPowerSourceChoice(evidence);
  if (choice.state === 'suspect') return choice;
  return { state: 'resolved', value: choice.state === 'chosen' ? choice.value : 'flow' };
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
