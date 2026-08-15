import type {
  StateOfChargeObservedFields,
  StateOfChargeObservedProbe,
} from '../../contracts/src/types';

/**
 * Type guard: the device has an observed state-of-charge bag. The observer owns
 * this reading outright — the plan device does not carry it at all — so this
 * guard is how every consumer reaches it. Test/narrow through it before reading
 * `stateOfCharge`; the field is omitted from the base snapshot types, so this
 * guard (or an already-narrowed value) is the only typed way to reach it. On
 * the narrowed shape `stateOfCharge` is a guaranteed
 * `DeviceStateOfChargeSnapshot` (never `undefined`), though the bag's own
 * `status`/`percent` semantics are NOT proven — consumers still gate on
 * `status === 'fresh'` etc. after narrowing.
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe) so the settings UI and widgets narrow the same
 * way the runtime does.
 *
 * PRESENCE-ONLY (no device-kind gate), like `hasObservedTemperature`: SoC is
 * carried by any device that reports a battery level (an EV charger, but also
 * potentially others), and SoC without a resolved EV plug-state is real — so
 * gating on EV identity would reject a present bag. Callers that also need EV
 * identity compose it explicitly. Presence proves the bag is present, NOT that
 * its `status` is `fresh`.
 *
 * NB it proves the *bag* object, not the finiteness of `percent` inside it.
 * "Present bag ⇒ finite, in-range `percent`" is a separate producer invariant
 * owned upstream by `normalizeStateOfChargePercent`
 * (`lib/device/transport/stateOfCharge.ts`), which refuses to build a bag for a
 * non-finite/out-of-range reading. Consumers that read `percent` after this guard
 * lean on that invariant; the safety-critical objectives feeder
 * (`lib/objectives/samples.ts`) additionally re-checks finiteness in depth.
 */
export const hasObservedStateOfCharge = <T extends StateOfChargeObservedProbe>(
  snapshot: T,
): snapshot is T & StateOfChargeObservedFields => (
  snapshot.stateOfCharge != null
);
