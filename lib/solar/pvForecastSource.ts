// PV-generation forecast source vocabulary. PELS has two forecast producers —
// the learned Open-Meteo model (`pvForecastService.ts`) and Homey Energy's own
// solar forecast (`homeyEnergySolarForecast.ts`) — one persisted setting
// choosing between them, and one shared port shape every consumer reads
// through so both producers stay interchangeable.
//
// The setting union is declared ONCE in
// `packages/contracts/src/settingsUiApi.ts` (type-only at runtime, so this
// re-export is safe) and classified ONCE in
// `packages/shared-domain/src/settings/pvForecastSource.ts`; this file
// re-exports the type so `lib/solar` consumers keep a local path to it.
// `auto` prefers Homey Energy's forecast whenever it carries useful data and
// falls back to the learned model; the explicit values pin one source (an
// explicit `homey_energy` with no forecast available means "no forecast",
// never a silent fallback).

import type { PvForecastSourceSetting } from '../../packages/contracts/src/settingsUiApi';
import type { PvForecastHour } from './pvForecastService';
import type { PvGainFit } from '../../packages/shared-domain/src/solar/pvGain';

export type { PvForecastSourceSetting };

export type PvForecastSourceId = Exclude<PvForecastSourceSetting, 'auto'>;

/**
 * What forecast consumers (planning-price surplus, curtailment potential)
 * read: forward per-hour kWh plus the confidence the curtailment discount
 * keys on. `getConfidence()` answering `null` means "no usable forecast" —
 * the same downstream treatment as an empty `forecast()`.
 */
export type PvForecastSourcePort = {
  forecast(hourStarts: readonly number[]): PvForecastHour[];
  getConfidence(): PvGainFit['confidence'] | null;
};

/** A selected source; `sourceId` is provenance for logging/UI — consumers never branch on it. */
export type SelectedPvForecast = PvForecastSourcePort & { readonly sourceId: PvForecastSourceId };
