import type {
  MeasuredPowerObservedFields,
  MeasuredPowerObservedProbe,
} from '../../contracts/src/types';

/**
 * Type guard: the device has an observed measured-power reading. A consumer must
 * test/narrow through this before reading `measuredPowerKw`; the fields are
 * omitted from the base snapshot types, so this guard (or an already-narrowed
 * value) is the only typed way to reach them. On the narrowed shape
 * `measuredPowerKw` is a guaranteed `number` (never `undefined`), while
 * `measuredPowerObservedAtMs` stays optional — the staleness-sensitive consumer
 * checks it independently.
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
 * producer invariant the write seams uphold — they all normalize through
 * {@link normalizeMeasuredPowerKw} — not a fact the guard re-proves.
 */
export const hasObservedMeasuredPower = <T extends MeasuredPowerObservedProbe>(
  snapshot: T,
): snapshot is T & MeasuredPowerObservedFields => (
  snapshot.measuredPowerKw != null
);

/**
 * The ONE rule for what counts as a device's measured power reading, applied by
 * every seam that can write `measuredPowerKw`: the parse-time resolver
 * (`DeviceMeasuredPowerResolver.resolveDirectWatts`), the realtime capability
 * event (`applyFreshnessOnlyCapabilityUpdate`), the snapshot-refresh observation
 * (`applyMeasuredPowerObservation`), and the plan producer (`getCurrentDrawKw`).
 * It exists so the invariant above is enforced in one place rather than asserted
 * in four.
 *
 * `null` means "not a reading", which each caller then handles as ABSENCE — not
 * as a floor to zero. Absence and "drawing nothing" are different facts, and
 * conflating them is what let a device measuring a true 0 W be credited its
 * nameplate.
 *
 * Two things are rejected:
 *  - non-finite (`NaN`/`Infinity`), which is junk from the SDK boundary;
 *  - NEGATIVE, which on a device-draw path is malformed. A thermostat, charger or
 *    heater never reports one. Negative watts DO mean something — production —
 *    but that is a different question answered on a different path by a different
 *    producer (`extractSolarProductionState` → `SolarProductionProducer`, which
 *    reads the raw capability and owns the sign), so rejecting one here discards
 *    nothing real.
 */
export const normalizeMeasuredPowerKw = (kw: unknown): number | null => (
  typeof kw === 'number' && Number.isFinite(kw) && kw >= 0 ? kw : null
);
