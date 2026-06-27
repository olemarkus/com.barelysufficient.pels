// PV generation forecast — applies the learned gain to the forecast sky.
//
// Forward step that closes the loop: clear-sky irradiance (clearSky.ts) attenuated
// by the MET cloud forecast, scaled by the learned device gain (pvGain.ts), gives
// the expected generation for a future hour. Pure: the runtime supplies clear-sky
// (computed from lat/lon) and the MET cloud forecast; this just multiplies.

import { clearnessFactor } from './pvGain';

export type PvForecastHourInput = {
  /** Clear-sky GHI for the hour (W/m²). */
  clearSkyWm2: number;
  /** Forecast MET cloud cover for the hour, 0 (clear) .. 1 (overcast). */
  cloudFraction: number;
};

/**
 * Expected generation (kWh) for one hour: `gain × clearSky × clearness`. Never
 * negative; zero at night (clear-sky 0) or full overcast (clearness 0).
 */
export const forecastPvKwh = (
  gainKwhPerWm2: number,
  clearSkyWm2: number,
  cloudFraction: number,
): number => {
  const effectiveWm2 = Math.max(0, clearSkyWm2) * clearnessFactor(cloudFraction);
  const kwh = gainKwhPerWm2 * effectiveWm2;
  return Number.isFinite(kwh) && kwh > 0 ? kwh : 0;
};

/** Forecast generation (kWh) for a series of forward hours, order preserved. */
export const forecastPvSeries = (
  gainKwhPerWm2: number,
  hours: readonly PvForecastHourInput[],
): number[] => hours.map((hour) => forecastPvKwh(gainKwhPerWm2, hour.clearSkyWm2, hour.cloudFraction));
