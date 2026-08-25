// PV-generation forecast source vocabulary. PELS has two forecast producers —
// the learned Open-Meteo model (`pvForecastService.ts`) and Homey Energy's own
// solar forecast (`homeyEnergySolarForecast.ts`) — and one persisted setting
// choosing between them. The union is declared ONCE in
// `packages/contracts/src/settingsUiApi.ts` (type-only at runtime, so this
// re-export is safe) and classified ONCE in
// `packages/shared-domain/src/settings/pvForecastSource.ts`; this file
// re-exports the type so `lib/solar` consumers keep a local path to it.
//
// The `auto` value prefers Homey Energy's forecast whenever it carries useful
// data and falls back to the learned model; the explicit values pin one source
// (an explicit `homey_energy` with no forecast available means "no forecast",
// never a silent fallback).

import type { PvForecastSourceSetting } from '../../packages/contracts/src/settingsUiApi';

export type { PvForecastSourceSetting };
