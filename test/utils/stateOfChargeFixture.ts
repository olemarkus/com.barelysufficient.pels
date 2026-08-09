import type {
  DeviceStateOfChargeSnapshot,
  EvSocUnavailableReason,
} from '../../packages/contracts/src/types';

/**
 * Builds a `DeviceStateOfChargeSnapshot` the way the producer builds one, so a
 * fixture cannot describe a state the producer would never emit.
 *
 * One argument decides both the raw `percent` the observation layer keeps and the
 * resolved `level` consumers act on, exactly as the producer does. Hand-written
 * literals had drifted apart from each other, and a consumer test then proved
 * behaviour against a snapshot the producer cannot emit.
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
    level: unavailable === undefined
      ? { kind: 'known', percent }
      : { kind: 'unavailable', reasonCode: unavailable },
  };
};
