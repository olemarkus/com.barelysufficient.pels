import type {
  TargetDeviceSnapshot,
  TemperatureObservedFields,
  TemperatureObservedProbe,
} from '../../contracts/src/types';

/**
 * A device snapshot that has an observed current temperature. On this narrowed
 * shape `currentTemperature` is a guaranteed `number` (never `undefined`) and,
 * by the producer invariant, finite — so consumers read it without re-handling
 * the absent case or re-checking `Number.isFinite`.
 */
export type TemperatureObservedSnapshot = TargetDeviceSnapshot & TemperatureObservedFields;

/**
 * Type guard: the device has an observed current temperature. The
 * observer-snapshot twin of the plan layer's `isTemperaturePlanDevice` — a
 * consumer must test/narrow through this before reading `currentTemperature`;
 * the field is omitted from the base snapshot types, so this guard (or an
 * already-narrowed value) is the only typed way to reach it.
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe) so the settings UI and widgets narrow the same
 * way the runtime does.
 *
 * Deliberately PRESENCE-ONLY (no device-kind gate), unlike `isEvObserved`:
 * `currentTemperature` derives from the `measure_temperature` capability, which
 * a non-temperature `deviceType` device can also carry, so gating on
 * `isTemperatureControlDevice` would reject a *present* reading. Callers that
 * also need the temperature-control kind compose it explicitly
 * (`isTemperatureControlDevice(d) && hasObservedTemperature(d)`), as
 * `lib/objectives/samples.ts` does — keeping "has a reading" and "is a
 * temperature device" as two honest, separately-asked questions.
 */
export const hasObservedTemperature = <T extends TemperatureObservedProbe>(
  snapshot: T,
): snapshot is T & TemperatureObservedFields => (
  // `!= null` (not just `!== undefined`) so this single narrowing chokepoint
  // also rejects a `null` that could slip in across the Homey SDK / JSON wire
  // boundary despite the `number | undefined` type — establishing the
  // finite-`number` guarantee once, here, is the whole point of the guard.
  // Matches the house idiom for this field (e.g. `deviceTransport` metrics).
  snapshot.currentTemperature != null
);
