// Wiring for the PV-forecast source selection: one closure both forecast
// consumers (`wireBudgetPrice`, `wireCurtailmentSurplus`) share, so the same
// selected source answers them by construction. The setting is read live per
// call (the price-scheme precedent) and the policy itself is pure
// (`lib/solar/pvForecastSourceSelection.ts`); this file only adapts the two
// controllers onto the shared port and logs source transitions.

import { selectPvForecastSource } from '../../lib/solar/pvForecastSourceSelection';
import type {
  PvForecastSourceId,
  PvForecastSourceSetting,
  SelectedPvForecast,
} from '../../lib/solar/pvForecastSource';
import type { HomeyEnergySolarForecastSource } from '../../lib/solar/homeyEnergySolarForecast';
import type { PvForecastService } from '../../lib/solar/pvForecastService';
import type { PvForecastLogger } from './createPvForecastService';

// Structural subsets of the two controllers — the selector needs only the
// forecast surface, and the narrow shapes let tests inject real domain
// objects without casts.
export type LearnedPvForecastLike = { service: Pick<PvForecastService, 'forecast' | 'getFit'> };
// The controller is asked for the SELECTED SOURCE as well as the forecast: it
// holds the `pv_forecast_source` setting (resolved at startup, re-resolved on
// the settings-change event), so the probe gate and both forecast consumers
// read one value and cannot disagree. Nothing here reads the SDK per call.
export type HomeySolarForecastLike = {
  source: Pick<HomeyEnergySolarForecastSource, 'forecast' | 'getConfidence' | 'hasUsefulForecast'>;
  getSourceSetting: () => PvForecastSourceSetting;
};

export type PvForecastSourceSelectorDeps = {
  learned: LearnedPvForecastLike;
  homey: HomeySolarForecastLike;
  getNowMs: () => number;
  logger: PvForecastLogger;
};

/**
 * Build the live `getSelectedPvForecast` closure. Both controllers are passed
 * BY VALUE, not behind getters: the only caller builds this closure in the same
 * step that constructs them, so "not wired yet" is not a state this closure can
 * be in and nothing downstream has to model it. The SELECTION is still
 * evaluated per call — a Homey outage changes `hasUsefulForecast` at any moment
 * and `auto` must follow it — but the SETTING behind it is held, not re-read.
 * Emits `pv_forecast_source_selected` on selection transitions only, so prod
 * logs can correlate which source feeds the planning price.
 * NOTE for log audits: the emitting call is the FIRST read after the change —
 * usually a combined-prices rebuild, but a settings-UI provenance read shares
 * this closure, so the line's timestamp marks when the change was observed,
 * not necessarily a planning read.
 */
export function createPvForecastSourceSelector(
  deps: PvForecastSourceSelectorDeps,
): () => SelectedPvForecast {
  const { learned, homey } = deps;
  let lastLoggedSourceId: PvForecastSourceId | undefined;
  return () => {
    const setting = homey.getSourceSetting();
    const selected = selectPvForecastSource({
      setting,
      homey: {
        hasUsefulForecast: homey.source.hasUsefulForecast(deps.getNowMs()),
        port: homey.source,
      },
      learned: {
        forecast: (hourStarts) => learned.service.forecast(hourStarts),
        // The learned fit is absent until enough production has been observed;
        // the port names that as `'none'` rather than passing a null onward.
        getConfidence: () => learned.service.getFit()?.confidence ?? 'none',
      },
    });
    if (selected.sourceId !== lastLoggedSourceId) {
      lastLoggedSourceId = selected.sourceId;
      deps.logger.info({ event: 'pv_forecast_source_selected', sourceId: selected.sourceId, setting });
    }
    return selected;
  };
}
