// Adapter for Homey Energy's solar forecast route (firmware 13.4.0+):
// `GET manager/energy/forecast/solar?date=YYYY-MM-DD`. Owns the COMPLETE
// classification of transport junk into the semantic `SolarForecastDayRead`
// before the solar domain sees it (root AGENTS.md → "Clean and trusted
// interfaces between layers"); `setup/homeyLocationAdapter.ts` is the pattern.
//
// Classification: only a definitive not-found (HTTP 404) is `unavailable` —
// the route does not exist (pre-13.4.0 firmware answers 404 with an HTML
// "Cannot GET" body) or Homey has no forecast basis (no solar device →
// not-found). Every other status (a 401/403 during a token hiccup, 429, 5xx)
// and every transport failure — timeout, network error, uninitialised REST
// client — is a transient `failed` the source treats as a no-op; treating
// those as definitive would clear last-good state on one flaky read.
//
// A malformed 200 body belongs on the transient side for the same reason: an
// HTML login page or a truncated answer is the transport talking, not Homey
// saying it has no forecast. Only the status line carries that verdict.

import { getRawFromHomeyApi } from '../lib/device/transport/managerHomeyApi';
import { resolveHomeyHttpStatusCode } from '../lib/utils/homeyHttpStatusError';
import type { SolarForecastDayRead } from '../lib/solar/homeyEnergySolarForecast';

export const SOLAR_FORECAST_API_PATH = 'manager/energy/forecast/solar';

export async function fetchSolarForecastDay(localDateKey: string): Promise<SolarForecastDayRead> {
  try {
    const body = await getRawFromHomeyApi(`${SOLAR_FORECAST_API_PATH}?date=${localDateKey}`);
    if (typeof body !== 'object' || body === null) return { kind: 'failed' };
    return { kind: 'resolved', body };
  } catch (error) {
    return resolveHomeyHttpStatusCode(error) === 404 ? { kind: 'unavailable' } : { kind: 'failed' };
  }
}
