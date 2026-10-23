/**
 * Device-state predicates shared by the runtime card text and the Settings
 * UI's device rendering, so the two cannot drift.
 *
 * The predicates accept the lowest-common-denominator shape — a string state
 * or a tiny structural type — so both `DeviceOverviewSnapshot` and
 * `TargetDeviceSnapshot`-style consumers can use them without coupling to a
 * specific contract.
 */

export const normalizeDeviceState = (value: string | undefined): string => (
  (value || '').trim().toLowerCase()
);

const NON_ON_LIKE_STATES = ['off', 'unknown', 'not_applicable'] as const;

export const isOnLikeState = (value: string | undefined): boolean => {
  const normalized = normalizeDeviceState(value);
  if (!normalized) return false;
  return !(NON_ON_LIKE_STATES as readonly string[]).includes(normalized);
};

export type GrayStateDeviceInput = {
  available?: boolean;
  currentState?: string;
};

export const isGrayStateDevice = (device: GrayStateDeviceInput | null | undefined): boolean => {
  if (!device) return false;
  if (device.available === false) return true;
  return normalizeDeviceState(device.currentState) === 'unknown';
};
