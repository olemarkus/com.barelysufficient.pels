import { isUnknownRecord } from '../recordGuards';

/** Charger opt-ins; an absent entry prefers the ordinary cheapest schedule. */
export type EvChargingSessionSmoothingSettings = Record<string, true>;

/** Resolve healthy opt-ins independently; malformed siblings grant no preference. */
export const normalizeEvChargingSessionSmoothingSettings = (value: unknown): EvChargingSessionSmoothingSettings => (
  isUnknownRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry === true).map(([id]) => [id, true as const]))
    : {}
);

/** A complete fresh map is required before a browser may merge and save one charger. */
export const isEvChargingSessionSmoothingSettings = (value: unknown): value is Record<string, boolean> => (
  isUnknownRecord(value) && Object.values(value).every(entry => typeof entry === 'boolean')
);
