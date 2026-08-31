import { getRawFromHomeyApi } from '../lib/device/transport/managerHomeyApi';
import type { HubCoordinatesResult } from '../lib/solar/pvForecastStore';

export const HOMEY_LOCATION_API_PATH = 'manager/geolocation/option/location';

// The contract is the domain's; this adapter only implements it. Re-exported
// for existing importers so there is one definition, not two that happen to
// agree today (`setup/AGENTS.md` § "Adapter naming").
export type { HubCoordinates, HubCoordinatesResult } from '../lib/solar/pvForecastStore';

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

/**
 * Resolve the Homey Web API's weakly-typed location response into finite hub
 * coordinates. Current Homey Pro wraps the coordinate object in `value`; the
 * direct shape remains accepted for compatibility with older API variants.
 */
export function normalizeHubCoordinates(raw: unknown): HubCoordinatesResult {
  const response = asRecord(raw);
  const candidate = asRecord(response?.value) ?? response;
  const latitude = candidate?.latitude;
  const longitude = candidate?.longitude;
  if (
    typeof latitude !== 'number'
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || typeof longitude !== 'number'
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
    || (latitude === 0 && longitude === 0)
  ) {
    return { kind: 'unavailable', outcome: 'no_location' };
  }
  return { kind: 'resolved', coordinates: { latitude, longitude } };
}

/**
 * Read the hub location through PELS's existing owner-authenticated Homey Web
 * API client. The adapter completely classifies malformed/absent responses and
 * thrown transport failures before either forecast domain sees the result.
 */
export async function readHubCoordinates(): Promise<HubCoordinatesResult> {
  try {
    return normalizeHubCoordinates(await getRawFromHomeyApi(HOMEY_LOCATION_API_PATH));
  } catch {
    return { kind: 'unavailable', outcome: 'failed' };
  }
}
