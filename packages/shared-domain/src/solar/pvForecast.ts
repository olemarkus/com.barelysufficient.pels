// PV generation forecast — applies the learned gain to the forecast irradiance.
//
// Forward step that closes the loop: shortwave irradiance (W/m², from the forecast
// source) scaled by the learned device gain (pvGain.ts) gives the expected
// generation for a future hour. Pure: the runtime supplies the forecast irradiance;
// this just multiplies.

/**
 * Expected generation (kWh) for one hour: `gain × irradiance`. Never negative;
 * zero at night / no irradiance.
 */
export const forecastPvKwh = (gainKwhPerWm2: number, irradianceWm2: number): number => {
  const kwh = gainKwhPerWm2 * Math.max(0, irradianceWm2);
  return Number.isFinite(kwh) && kwh > 0 ? kwh : 0;
};
