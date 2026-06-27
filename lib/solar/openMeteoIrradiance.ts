// Open-Meteo shortwave-irradiance provider — the real PvIrradianceProvider.
//
// Fetches hourly shortwave radiation (W/m²) from Open-Meteo for the hub's
// coordinates into an in-memory per-UTC-hour map, refreshed periodically by the
// wiring layer. `getIrradiance` answers both the recorded nowcast (current hour,
// for training) and the forward forecast from the same cache.
//
// Open-Meteo is free, key-less, CC-BY 4.0 (attribution required). The HTTP `fetch`
// is injected so the parser + provider stay unit-testable. Boundary discipline:
// only finite, non-negative radiation paired with a finite hour timestamp is kept
// — a malformed entry is skipped (absence is `undefined`, never a fabricated 0).

import { isFiniteNumber } from '../utils/appTypeGuards';
import type { PvIrradianceProvider } from './pvForecastService';

const HOUR_MS = 3_600_000;

export type GeoCoordinates = { latitude: number; longitude: number };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

/** Open-Meteo forecast URL: hourly shortwave radiation, unix timestamps, yesterday→tomorrow. */
export function buildOpenMeteoIrradianceUrl(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(4);
  const lon = longitude.toFixed(4);
  return 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&hourly=shortwave_radiation&timeformat=unixtime&past_days=1&forecast_days=2';
}

/**
 * Parse an Open-Meteo response into a UTC-hour-start (ms, stringified) → W/m² map.
 * Defensive: tolerates missing/short/ragged arrays; drops any entry whose time or
 * radiation is non-finite or whose radiation is negative.
 */
export function parseOpenMeteoRadiation(raw: unknown): Record<string, number> {
  const hourly = isRecord(raw) ? raw.hourly : undefined;
  if (!isRecord(hourly) || !Array.isArray(hourly.time) || !Array.isArray(hourly.shortwave_radiation)) {
    return {};
  }
  const times: unknown[] = hourly.time;
  const values: unknown[] = hourly.shortwave_radiation;
  const count = Math.min(times.length, values.length);
  return Object.fromEntries(
    times.slice(0, count).flatMap((unixSeconds, i): Array<readonly [string, number]> => {
      const wm2 = values[i];
      if (!isFiniteNumber(unixSeconds) || !isFiniteNumber(wm2) || wm2 < 0) return [];
      // Open-Meteo radiation is a PRECEDING-hour mean: a value stamped at 06:00 is
      // the 05:00–06:00 average. Key it to the interval START — the hour the
      // generation it explains occurred in — i.e. one hour before the stamp.
      const hourStartMs = Math.floor((unixSeconds * 1000) / HOUR_MS) * HOUR_MS - HOUR_MS;
      return [[String(hourStartMs), wm2]];
    }),
  );
}

export type OpenMeteoIrradianceDeps = {
  getCoordinates: () => GeoCoordinates | null | undefined;
  /** Injected HTTP boundary (the real `fetch`); kept injectable for unit tests. */
  fetchImpl?: typeof fetch;
  /** App identifier for the request (attribution / contact), e.g. "<app-id>/<ver> (<contact>)". */
  userAgent: string;
};

export type OpenMeteoRefreshOutcome = 'ok' | 'no_location' | 'failed';

/** Coordinates of (0, 0) are the Homey "unset location" sentinel — never fetch them. */
const hasUsableLocation = (
  coordinates: GeoCoordinates | null | undefined,
): coordinates is GeoCoordinates => (
  coordinates != null // handles both null and undefined (Homey may return either)
  && Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude)
  && !(coordinates.latitude === 0 && coordinates.longitude === 0)
);

export class OpenMeteoIrradianceProvider implements PvIrradianceProvider {
  private byHour: Record<string, number> = {};

  constructor(private readonly deps: OpenMeteoIrradianceDeps) {}

  /** Refetch the radiation forecast. On any failure the prior cache is kept untouched. */
  async refresh(): Promise<OpenMeteoRefreshOutcome> {
    const coordinates = this.deps.getCoordinates();
    if (!hasUsableLocation(coordinates)) return 'no_location';
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(
        buildOpenMeteoIrradianceUrl(coordinates.latitude, coordinates.longitude),
        { headers: { 'User-Agent': this.deps.userAgent } },
      );
      if (!response.ok) return 'failed';
      const parsed = parseOpenMeteoRadiation(await response.json());
      if (Object.keys(parsed).length === 0) return 'failed';
      this.byHour = parsed;
      return 'ok';
    } catch {
      return 'failed';
    }
  }

  /** Cached radiation (W/m²) for a UTC hour-start, or `undefined` when unknown. */
  getIrradiance(hourStartMs: number): number | undefined {
    const value = this.byHour[String(hourStartMs)];
    return isFiniteNumber(value) ? value : undefined;
  }
}
