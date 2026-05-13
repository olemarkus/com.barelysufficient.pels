/**
 * Device-state predicates shared by the runtime overview generator
 * (`deviceOverview.ts`) and the Settings UI's plan-legacy / device-utils
 * rendering. Centralizing them avoids the drift we had between the two copies
 * (e.g. one normalized case, the other did not; one treated `'disappeared'`
 * as on-like, the other did not).
 *
 * The predicates accept the lowest-common-denominator shape — a string state
 * or a tiny structural type — so both `DeviceOverviewSnapshot` and
 * `TargetDeviceSnapshot`-style consumers can use them without coupling to a
 * specific contract.
 */

export const normalizeDeviceState = (value: string | undefined): string => (
  (value || '').trim().toLowerCase()
);

const NON_ON_LIKE_STATES = ['off', 'unknown', 'not_applicable', 'disappeared'] as const;
const OFF_LIKE_STATES = ['off', 'unknown'] as const;
const GRAY_CURRENT_STATES = ['unknown', 'disappeared'] as const;

export const isOnLikeState = (value: string | undefined): boolean => {
  const normalized = normalizeDeviceState(value);
  if (!normalized) return false;
  return !(NON_ON_LIKE_STATES as readonly string[]).includes(normalized);
};

export const isOffLikeState = (value: string | undefined): boolean => (
  (OFF_LIKE_STATES as readonly string[]).includes(normalizeDeviceState(value))
);

export type GrayStateDeviceInput = {
  available?: boolean;
  currentState?: string;
  observationStale?: boolean;
};

export const isGrayStateDevice = (device: GrayStateDeviceInput | null | undefined): boolean => {
  if (!device) return false;
  if (device.available === false) return true;
  if (device.observationStale === true) return true;
  return (GRAY_CURRENT_STATES as readonly string[]).includes(normalizeDeviceState(device.currentState));
};
