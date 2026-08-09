import type {
  DeviceStateOfChargeSnapshot,
  EvSocUnavailableReason,
} from '../../packages/contracts/src/types';

/**
 * Builds a `DeviceStateOfChargeSnapshot` the way the producer builds one, so a
 * fixture cannot describe a state the producer would never emit.
 *
 * The pairing is the point: `level` and the legacy `status` are derived from one
 * argument here, exactly as `resolveLevelFields` derives them in
 * `lib/device/transport/stateOfCharge.ts`. Hand-written literals had drifted
 * apart from each other (`status: 'stale'` beside a usable percentage), and a
 * consumer test then proved behaviour against a snapshot that cannot occur.
 *
 * Pass `unavailable` to build the no-level case — the percentage is still
 * carried, because the producer carries it too; what it does not do is call it
 * the device's level.
 */
export const stateOfChargeFixture = (params: {
  percent: number;
  observedAtMs?: number;
  unavailable?: EvSocUnavailableReason;
  capabilityId?: string;
  sessionStartedAtMs?: number;
  invalidatedAtMs?: number;
  source?: 'car';
  sourceDeviceId?: string;
}): DeviceStateOfChargeSnapshot => {
  const { percent, unavailable, ...rest } = params;
  return {
    percent,
    ...rest,
    ...(unavailable === undefined
      ? { level: { kind: 'known', percent }, status: 'fresh' }
      : {
        level: { kind: 'unavailable', reasonCode: unavailable },
        status: params.observedAtMs === undefined ? 'unknown' : 'stale',
      }),
  };
};
