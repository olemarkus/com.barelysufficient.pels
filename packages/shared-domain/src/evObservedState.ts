import type { EvObservedFields, EvObservedProbe, TargetDeviceSnapshot } from '../../contracts/src/types';
import { isEvDevice } from './commandableNow';

/**
 * A device snapshot that is BOTH an EV charger AND has a resolved plug-state.
 * On this narrowed shape `evChargingState` is a guaranteed `EvChargingState`
 * (never `undefined`), so consumers branch on a known value without re-handling
 * the absent case.
 */
export type EvObservedSnapshot = TargetDeviceSnapshot & EvObservedFields;

/**
 * Type guard: the device is an EV charger whose plug-state has been observed
 * (not a non-EV device, and not an EV charger still at cold start with no
 * trusted state yet). The observer-snapshot twin of `isEvPlanDevice` — a
 * consumer must test/narrow through this before reading `evChargingState`;
 * the field is omitted from the base snapshot types, so this guard (or an
 * already-narrowed value) is the only typed way to reach it.
 *
 * Generic over the carrier so it narrows `TargetDeviceSnapshot`,
 * `DecoratedDeviceSnapshot`, and probe-widened owner shapes alike. Lives in
 * shared-domain (browser-safe, next to `isEvDevice`) so the settings UI can
 * narrow the same way the runtime does.
 *
 * A `false` result therefore covers two cases the caller handles at the
 * boundary: a non-EV device, or an EV charger with no resolved state yet (the
 * pessimistic "state unknown / uncommandable" case).
 */
export const isEvObserved = <T extends { deviceClass?: string; controlCapabilityId?: string } & EvObservedProbe>(
  snapshot: T,
): snapshot is T & EvObservedFields => (
  isEvDevice(snapshot) && snapshot.evChargingState !== undefined
);
