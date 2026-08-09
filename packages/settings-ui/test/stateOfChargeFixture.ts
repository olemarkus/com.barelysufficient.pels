import type {
  DeviceStateOfChargeSnapshot,
  EvSocUnavailableReason,
} from '../../contracts/src/types';

/**
 * Settings-UI copy of `test/utils/stateOfChargeFixture.ts`.
 *
 * Duplicated deliberately: the settings UI is its own package and must not reach
 * into the runtime test tree, so consolidating these two would cross the package
 * boundary the architecture rules draw (`AGENTS.md` — "accept code duplication
 * if consolidation would violate an architectural boundary"). Both build the
 * snapshot the way the producer does, so `level` and the legacy `status` cannot
 * drift apart inside a fixture.
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
