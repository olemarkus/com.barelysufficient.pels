import type {
  DeviceStateOfChargeSnapshot,
  EvSocUnavailableReason,
} from '../../packages/contracts/src/types';

/**
 * The stamp a fixture gets when the caller did not name one.
 *
 * A known level always carries a timestamp — `resolveStateOfChargeLevel` refuses
 * to resolve one without it — so a fixture asking for a known level has to supply
 * something. Deliberately tiny and obviously synthetic: a test that cares about
 * age passes its own, and every real report is newer than this, so the
 * `Math.max(previous, reported)` carry-forward always takes the real one.
 */
const UNSTATED_OBSERVED_AT_MS = 1;

/**
 * Builds a `DeviceStateOfChargeSnapshot` the way the producer builds one, so a
 * fixture cannot describe a state the producer would never emit.
 *
 * One argument decides both the raw `report.percent` the observation layer keeps
 * and the resolved `level` consumers act on, exactly as the producer does.
 * Hand-written literals had drifted apart from each other, and a consumer test
 * then proved behaviour against a snapshot the producer cannot emit.
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
  /** Present = the level was read off this car; absent = the charger reported it. */
  carId?: string;
}): DeviceStateOfChargeSnapshot => {
  const {
    percent, unavailable, observedAtMs, capabilityId, carId, ...session
  } = params;
  // Every report is dated (the producer's rule, and the type's); a caller that
  // does not care when gets the placeholder.
  const stamp = observedAtMs ?? UNSTATED_OBSERVED_AT_MS;
  return {
    ...session,
    report: { percent, observedAtMs: stamp },
    capabilityId: capabilityId ?? 'measure_battery',
    source: carId === undefined ? { kind: 'charger' } : { kind: 'car', carId },
    level: unavailable === undefined
      ? { kind: 'known', percent, observedAtMs: stamp ?? UNSTATED_OBSERVED_AT_MS }
      : { kind: 'unavailable', reasonCode: unavailable },
  };
};
