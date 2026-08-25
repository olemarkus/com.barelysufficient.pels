// The pure PV-forecast source-selection policy: which of the two producers
// answers the consumers for this instant. Evaluated live on every consumer
// call by the setup selector, so a Homey outage or a setting flip takes
// effect at the next read without extra wiring.

import type {
  PvForecastSourcePort,
  PvForecastSourceSetting,
  SelectedPvForecast,
} from './pvForecastSource';

/**
 * `learned` and `homey_energy` pin their source — an explicit `homey_energy`
 * with nothing available stays selected and honestly answers "no forecast"
 * (empty `forecast()`, null confidence), never a silent fallback. `auto`
 * prefers Homey only while its data is USEFUL (covers a current-or-future
 * hour with positive energy — `HomeyEnergySolarForecastSource
 * .hasUsefulForecast`), else the learned model keeps serving.
 */
export function selectPvForecastSource(params: {
  setting: PvForecastSourceSetting;
  homey: { hasUsefulForecast: boolean; port: PvForecastSourcePort };
  learned: PvForecastSourcePort;
}): SelectedPvForecast {
  const homey: SelectedPvForecast = {
    sourceId: 'homey_energy',
    forecast: (hourStarts) => params.homey.port.forecast(hourStarts),
    getConfidence: () => params.homey.port.getConfidence(),
  };
  const learned: SelectedPvForecast = {
    sourceId: 'learned',
    forecast: (hourStarts) => params.learned.forecast(hourStarts),
    getConfidence: () => params.learned.getConfidence(),
  };
  if (params.setting === 'homey_energy') return homey;
  if (params.setting === 'learned') return learned;
  return params.homey.hasUsefulForecast ? homey : learned;
}
