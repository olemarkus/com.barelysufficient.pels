/**
 * Type guard: the device has an observed state-of-charge bag. The observer owns
 * this reading outright — the plan device does not carry it at all — so this
 * guard is how every consumer reaches it. Test/narrow through it before reading
 * `stateOfCharge`; the field is omitted from the base snapshot types, so this
 * guard (or an already-narrowed value) is the only typed way to reach it. On the
 * narrowed shape `stateOfCharge` is guaranteed present, never `undefined` —
 * but PRESENT IS NOT A LEVEL. Whether the charger has one is `level.kind`, which
 * consumers read for themselves after narrowing.
 *
 * Generic over the carrier AND over what the carrier holds, so one guard serves
 * both shapes of the fact: inside the observation layer `stateOfCharge` is the
 * transport's `DeviceStateOfChargeSnapshot`, while everything served through
 * `/ui_devices` carries the resolved `ObservedStateOfCharge`. Narrowing to
 * `NonNullable<T['stateOfCharge']>` gives each caller back exactly the type its
 * own carrier declared, so a consumer of the resolved payload cannot reach a
 * field the payload does not carry. Lives in shared-domain (browser-safe) so the
 * settings UI and widgets narrow the same way the runtime does.
 *
 * PRESENCE-ONLY (no device-kind gate), like `hasObservedTemperature`: SoC is
 * carried by any device that reports a battery level (an EV charger, but also
 * potentially others), and SoC without a resolved EV plug-state is real — so
 * gating on EV identity would reject a present bag. Callers that also need EV
 * identity compose it explicitly.
 *
 * NB it proves the carrier object, not the finiteness of the percentage inside
 * it. "Present ⇒ finite, in-range percentage" is a separate producer invariant
 * owned upstream by `normalizeStateOfChargePercent`
 * (`lib/device/transport/stateOfCharge.ts`), which refuses to build a bag for a
 * non-finite/out-of-range reading.
 */
export const hasObservedStateOfCharge = <T extends { stateOfCharge?: unknown }>(
  snapshot: T,
): snapshot is T & { stateOfCharge: NonNullable<T['stateOfCharge']> } => (
  snapshot.stateOfCharge != null
);
