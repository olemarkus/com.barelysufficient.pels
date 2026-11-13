import { isUnknownRecord } from '../recordGuards';

/** How the owner says a device is wired to the main fuse's phases. An absent entry is Automatic. */
export type DevicePhaseConnection = 'L1' | 'L2' | 'L3' | 'all' | 'self_balancing'
  | 'three_L1' | 'three_L2' | 'three_L3';

export const DEVICE_PHASE_CONNECTIONS_VALUES: readonly DevicePhaseConnection[] = [
  'L1', 'L2', 'L3', 'all', 'self_balancing', 'three_L1', 'three_L2', 'three_L3',
];

const isDevicePhaseConnection = (value: unknown): value is DevicePhaseConnection => (
  DEVICE_PHASE_CONNECTIONS_VALUES.includes(value as DevicePhaseConnection)
);

/**
 * The whole-map guard for `device_phase_connections`, shared by the runtime
 * reader and the settings UI so the two cannot disagree. All or nothing: a map
 * with one bad entry is a read to retry, and each reader keeps its last good map.
 */
export const isDevicePhaseConnectionMap = (
  value: unknown,
): value is Record<string, DevicePhaseConnection> => (
  isUnknownRecord(value) && Object.values(value).every(isDevicePhaseConnection)
);
