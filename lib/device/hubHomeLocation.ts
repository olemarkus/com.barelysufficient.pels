import { getRawFromHomeyApi, HOMEY_LOCATION_API_PATH } from './transport/managerHomeyApi';
import { readCoordinates, type Coordinates, type HomeLocation } from './teslaChargingEvidence';

const RETRY_MS = 60_000;
const REFRESH_MS = 6 * 60 * 60_000;

function parseLocation(raw: unknown): Coordinates | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  // Current Homey Pro wraps the coordinates in `value`.
  const body = 'value' in raw && typeof raw.value === 'object' && raw.value !== null ? raw.value : raw;
  const latitude = 'latitude' in body ? body.latitude : undefined;
  const longitude = 'longitude' in body ? body.longitude : undefined;
  if (latitude === 0 && longitude === 0) return undefined;
  return readCoordinates(latitude, longitude);
}

/**
 * The hub's location, read through the owner-authenticated Web API that
 * `homey:manager:api` already grants, so PELS needs no SDK geolocation
 * permission. A failed or empty read keeps the last accepted coordinates.
 */
export class HubHomeLocation implements HomeLocation {
  private accepted: Coordinates | undefined;
  private nextReadAtMs = 0;
  private pending: Promise<void> | undefined;

  coordinates(): Coordinates | undefined { return this.accepted; }

  /** Starts a read when one is due; resolves once any read in progress has settled. */
  refreshIfDue(): Promise<void> {
    if (this.pending || Date.now() < this.nextReadAtMs) return this.pending ?? Promise.resolve();
    this.pending = this.read().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async read(): Promise<void> {
    let coordinates: Coordinates | undefined;
    try {
      coordinates = parseLocation(await getRawFromHomeyApi(HOMEY_LOCATION_API_PATH));
    } catch {
      coordinates = undefined;
    }
    if (coordinates) this.accepted = coordinates;
    this.nextReadAtMs = Date.now() + (coordinates ? REFRESH_MS : RETRY_MS);
  }
}
