import type {
  MeasuredPowerObservedFields,
  MeasuredPowerObservedProbe,
} from '../../contracts/src/types';

/**
 * A device snapshot that has an observed measured-power reading. On this narrowed
 * shape `measuredPowerKw` is a guaranteed `number` (never `undefined`), so
 * consumers read it without re-handling the absent case. `measuredPowerObservedAtMs`
 * stays optional — the staleness-sensitive consumer checks it independently.
 */
export type MeasuredPowerObservedSnapshot<T> = T & MeasuredPowerObservedFields;

/**
 * Type guard: the device has an observed measured-power reading. A consumer must
 * test/narrow through this before reading `measuredPowerKw`; the fields are
 * omitted from the base snapshot types, so this guard (or an already-narrowed
 * value) is the only typed way to reach them.
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe) so the settings UI and widgets narrow the same way
 * the runtime does.
 *
 * PRESENCE-ONLY (no device-kind gate), like `hasObservedTemperature`: a measured
 * power reading is carried by any power-metered device. Power-measurement absence
 * is the legitimate common case (most devices don't measure power), so the guard
 * draws the present/absent line; "present implies finite, non-negative kW" is the
 * producer invariant the write seams uphold (they only store `Number.isFinite`
 * readings), not a fact the guard re-proves.
 */
export const hasObservedMeasuredPower = <T extends MeasuredPowerObservedProbe>(
  snapshot: T,
): snapshot is T & MeasuredPowerObservedFields => (
  snapshot.measuredPowerKw != null
);
