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

/**
 * Whether the active source delivers a whole-home PRODUCTION reading (gross PV
 * generation) alongside net power. Homey Energy co-samples it as
 * `totalGenerated.W`; the Flow card reports net power only.
 *
 * This is the ONE place the source identity is allowed to become a capability.
 * Consumers must branch on the capability, never on the source name — a
 * downstream `=== 'homey_energy'` re-derives a fact it has no business knowing,
 * and every such check has to be revisited whenever a source gains or loses a
 * channel (exactly what happened when the Flow card started accepting signed
 * watts: half of each gate's justification silently became false).
 *
 * NET power is deliberately not modelled here — both sources deliver it, signed,
 * on equal terms.
 */
export const deliversProductionSignal = (source: PowerSource): boolean => (
  source === 'homey_energy'
);

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
