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
