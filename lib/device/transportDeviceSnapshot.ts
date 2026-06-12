import type { EvObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * Owner-side snapshot shape (EV-observed slice of the discriminated-types
 * refactor). The transport stores ONE mutable snapshot object per device across
 * kinds and writes `evChargingState` in place during the fresher-wins merge, so
 * its internal carriers widen the consumer-facing `TargetDeviceSnapshot` (which
 * omits the field; see `EvObservedFields` in `packages/contracts/src/types.ts`)
 * with the optional `EvObservedProbe`.
 *
 * This shape is for the transport/observer OWNER seams only. It must not leak
 * across the producer boundary — consumers receive `TargetDeviceSnapshot` (the
 * widened object is assignable to it) and narrow through `isEvObserved`
 * (`packages/shared-domain/src/evObservedState.ts`).
 */
export type TransportDeviceSnapshot = TargetDeviceSnapshot & EvObservedProbe;
