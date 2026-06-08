import type { EvChargingState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';

/**
 * A device snapshot that is BOTH an EV charger AND has a resolved plug-state.
 * On this narrowed shape `evChargingState` is a guaranteed `EvChargingState`
 * (never `undefined`), so consumers branch on a known value without re-handling
 * the absent case.
 */
export type EvObservedSnapshot = TargetDeviceSnapshot & { evChargingState: EvChargingState };

/**
 * Type guard: the device is an EV charger whose plug-state has been observed
 * (not a non-EV device, and not an EV charger still at cold start with no
 * trusted state yet). The observer-snapshot twin of `isEvPlanDevice` — a
 * consumer must test/narrow through this before reading `evChargingState`,
 * rather than reading the optional field and re-deciding what `undefined` means.
 *
 * A `false` result therefore covers two cases the caller handles at the
 * boundary: a non-EV device, or an EV charger with no resolved state yet (the
 * pessimistic "state unknown / uncommandable" case).
 */
export const isEvObserved = (snapshot: TargetDeviceSnapshot): snapshot is EvObservedSnapshot => (
  isEvDevice(snapshot) && snapshot.evChargingState !== undefined
);
