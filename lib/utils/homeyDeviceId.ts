const CANONICAL_HOMEY_DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Closed grammar for Homey device ids crossing persisted settings boundaries.
 * Homey's ids are opaque, but the app's persisted fingerprints use `|` as a
 * structural separator and `automatic` as a reserved arm. Keeping accepted ids
 * to the ASCII identifier alphabet used by Homey makes composition and parsing
 * exact inverses.
 */
export const isCanonicalHomeyDeviceId = (value: unknown): value is string => (
  typeof value === 'string'
  && value !== 'automatic'
  && CANONICAL_HOMEY_DEVICE_ID.test(value)
);
