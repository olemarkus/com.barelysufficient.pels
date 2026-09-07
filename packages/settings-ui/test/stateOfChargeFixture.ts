import type {
  EvSocUnavailableReason,
  ObservedStateOfCharge,
} from '../../contracts/src/types';

/**
 * Settings-UI counterpart of `test/utils/stateOfChargeFixture.ts`, and NOT the
 * same shape.
 *
 * The runtime fixture builds the transport's `DeviceStateOfChargeSnapshot`. The
 * settings UI never sees one: `/ui_devices` resolves state of charge to the level
 * before serving it (`withResolvedStateOfCharge`), so this builds
 * `ObservedStateOfCharge` — what a settings-UI consumer is actually handed.
 * Building the bag here would let a test drive a consumer with a shape production
 * never serves, and a `report.percent` read would pass green while finding
 * `undefined` in the WebView.
 *
 * Separate file rather than a shared one: the settings UI is its own package and
 * must not reach into the runtime test tree (`AGENTS.md` — "accept code
 * duplication if consolidation would violate an architectural boundary").
 */

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
 * Builds the state of charge a settings-UI consumer is handed: the level alone.
 *
 * Deliberately NOT the transport's parameters. `capabilityId`, the session pair
 * and the car id shape a level at the producer, and by the time the value
 * reaches this side that work is done — accepting them here would let a test
 * think it had set something the code under test cannot see.
 *
 * Pass `unavailable` for the no-level case: the charger reports, but PELS has no
 * level to show for it. That is distinct from the device carrying no state of
 * charge at all, which is the field being absent.
 */
export const stateOfChargeFixture = (params: {
  percent: number;
  observedAtMs?: number;
  unavailable?: EvSocUnavailableReason;
}): ObservedStateOfCharge => {
  const { percent, unavailable, observedAtMs } = params;
  return {
    level: unavailable === undefined
      ? { kind: 'known', percent, observedAtMs: observedAtMs ?? UNSTATED_OBSERVED_AT_MS }
      : { kind: 'unavailable', reasonCode: unavailable },
  };
};
