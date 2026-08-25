/**
 * The `pv_forecast_source` setting: one key, one reader.
 *
 * Which forecast of the home's solar production feeds planning — Homey Energy's
 * own solar forecast (firmware 13.4.0+), the model PELS learns from the home's
 * measured production, or automatic preference between them.
 *
 * The key has two callers from the start — the runtime reader
 * (`setup/pvForecastSourceSetting.ts`, over `homey.settings`) and the settings
 * UI (`priceConfigSettingsIo.ts`, over the async bridge) — which is exactly the
 * shape `notes/settings-key-ownership.md` exists to keep from drifting: two
 * local parsers can silently disagree about what a junk value means, and then
 * planning and the UI would report different sources for the same bytes.
 *
 * Transport stays with the callers, and so does the meaning of ABSENCE: the
 * runtime can cross-check `getKeys()`, the UI cannot. Here the two coincide
 * anyway — see the read policy below.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { PvForecastSourceSetting } from '../../../contracts/src/settingsUiApi.js';

/**
 * Read policy: RECOGNISE OR DEFAULT.
 *
 * A flat three-value union, so there is nothing to sanitize partially — a value
 * is one of the three or it is not. Anything else, absence included, reads as
 * `'auto'`: the mode that already tolerates a missing forecast (it prefers
 * Homey's forecast only while that forecast carries useful forward energy, and
 * serves the learned model otherwise), which is what a never-written key wants.
 *
 * This classifier does NOT distinguish a never-written key from a transient SDK
 * read miss, and it deliberately does not try. Distinguishing them needs a
 * SECOND READ, and this function is shared with the settings UI, which reads the
 * same bytes over the Homey API bridge and must never retry an SDK call it does
 * not make. The runtime resolves that ambiguity at its own read site
 * (`setup/pvForecastSourceSetting.ts`) by reading again, and holds the result —
 * see that file for why a held value is correct for this key.
 *
 * There is deliberately no write policy: the only writer is the settings UI's
 * select, whose options are the union itself.
 */
export const isPvForecastSourceSetting = (value: unknown): value is PvForecastSourceSetting => (
  value === 'homey_energy' || value === 'learned' || value === 'auto'
);

export const normalizePvForecastSourceSetting = (value: unknown): PvForecastSourceSetting => (
  isPvForecastSourceSetting(value) ? value : 'auto'
);

export type { PvForecastSourceSetting };
