import type { EvObservedFields, EvObservedProbe } from '../../contracts/src/types';
import { isEvDevice } from './evPlugState';

/**
 * Type guard: the device is an EV charger, and therefore has an observed
 * plug-state. A consumer must narrow through this before reading
 * `evChargingState`; the field is omitted
 * from the base snapshot types, so this guard (or an already-narrowed value) is
 * the only typed way to reach it.
 *
 * **The predicate is EV-ness alone, and presence follows from it.** Every EV
 * charger exposes `evcharger_charging_state` — the amp/step axis
 * (`target_power`, stepped-load) is a different axis and does not replace it —
 * so the parse boundary requires the capability of every `evcharger`
 * (`managerNativeEv.resolveCandidateCapabilities`) and requires a member of the
 * Homey enum for its value (`managerParse.shouldDropForEvPlugStateContract`),
 * dropping the device otherwise. "EV charger with an unknown plug-state" is not
 * a state PELS represents; it is a device PELS does not manage. Same shape as
 * `currentOn`, which the parse boundary likewise makes contractually present.
 *
 * **That holds at the OBSERVED snapshot, and nowhere downstream of a producer
 * that strips the field.** The guard asserts presence from EV-ness alone, so on
 * a carrier whose plug-state has been resolved away it narrows to a type whose
 * `evChargingState` is required and whose runtime value is `undefined` — tsc
 * reports a satisfied contract while the branch behind it can never be true.
 * That is not hypothetical: `toPlanDevice` strips the raw plug-state, and the
 * two `isEvObserved(device) && isEvSessionInactive(...)` reads in
 * `lib/objectives` were dead for months, reporting an unplugged charger as a
 * stale reading for whole task windows. Narrow with this ONLY on a snapshot
 * that still carries observed state; past a producer, read the bit the producer
 * resolved (`commandableNow`, `hasStandingDemand`).
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe, next to `isEvDevice`) so the settings UI can
 * narrow the same way the runtime does.
 */
export const isEvObserved = <T extends { deviceClass?: string } & EvObservedProbe>(
  snapshot: T,
): snapshot is T & EvObservedFields => isEvDevice(snapshot);
