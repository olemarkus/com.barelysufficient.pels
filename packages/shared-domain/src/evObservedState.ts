import type { EvObservedFields, EvObservedProbe } from '../../contracts/src/types';
import { isEvDevice } from './commandableNow';

/**
 * Type guard: the device is an EV charger whose plug-state has been observed
 * (not a non-EV device, and not an EV charger still at cold start with no
 * trusted state yet). The observer-snapshot twin of `isEvPlanDevice` — a
 * consumer must test/narrow through this before reading `evChargingState`;
 * the field is omitted from the base snapshot types, so this guard (or an
 * already-narrowed value) is the only typed way to reach it. On the narrowed
 * shape `evChargingState` is a guaranteed `EvChargingState` (never
 * `undefined`), so consumers branch on a known value without re-handling the
 * absent case.
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe, next to `isEvDevice`) so the settings UI can
 * narrow the same way the runtime does.
 *
 * A `false` result therefore covers two cases the caller handles at the
 * boundary: a non-EV device, or an EV charger with no resolved plug-state. The
 * latter is NOT a block — absence collapses a permanently-absent capability, a
 * cold start, and a vendor value outside the enum, so commandability consumers
 * treat it as "nothing known against commanding" (`resolveEvBlockReasonKey`).
 */
export const isEvObserved = <T extends { deviceClass?: string; controlCapabilityId?: string } & EvObservedProbe>(
  snapshot: T,
): snapshot is T & EvObservedFields => (
  isEvDevice(snapshot) && snapshot.evChargingState !== undefined
);
