import type {
  BinaryControlCapabilityId,
  BinaryControlObservation,
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  StateOfChargeObservedProbe,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';

/**
 * Raw Homey routing metadata. This is deliberately private to the transport
 * owner seam: consumers receive semantic binary/target/step state and never a
 * capability or Flow address.
 */
export type TransportControlBindingProbe = {
  binaryCapabilityId?: BinaryControlCapabilityId;
  binaryWriteCapabilityId?: string;
  binaryObservationCapabilityId?: string;
  flowBackedCapabilityIds?: string[];
};

export type TransportBinaryControlObservation = BinaryControlObservation;

/**
 * Owner-side snapshot shape (discriminated-types refactor). The transport stores
 * ONE mutable snapshot object per device across kinds and writes the observed
 * cluster fields in place during the fresher-wins merge, so its internal
 * carriers widen the consumer-facing `TargetDeviceSnapshot` (which omits those
 * fields) with the matching optional probes:
 * - `EvObservedProbe` for `evChargingState` (see `EvObservedFields`).
 * - `TemperatureObservedProbe` for `currentTemperature` (see
 *   `TemperatureObservedFields`).
 * - `StateOfChargeObservedProbe` for `stateOfCharge` (see
 *   `StateOfChargeObservedFields`).
 * - `MeasuredPowerObservedProbe` for `measuredPowerKw` /
 *   `measuredPowerObservedAtMs` (see `MeasuredPowerObservedFields`).
 * - `SteppedLoadDescriptorProbe` for `steppedLoadProfile` / `targetPowerConfig`
 *   (see `SteppedLoadDescriptorFields`).
 * - `ReportedStepObservedProbe` for `reportedStepId` and exact target-power
 *   evidence (see
 *   `ReportedStepObservedFields`).
 *
 * This shape is for the transport/observer OWNER seams only. It must not leak
 * across the producer boundary — consumers receive `TargetDeviceSnapshot` (the
 * widened object is assignable to it) and narrow through `isEvObserved` /
 * `hasObservedTemperature` / `hasObservedStateOfCharge` /
 * `hasObservedMeasuredPower` / `isSteppedLoadSnapshot` / `hasObservedReportedStep`
 * (`packages/shared-domain/src/*ObservedState.ts`).
 */
export type TransportDeviceSnapshot =
  Omit<TargetDeviceSnapshot, 'binaryControlObservation'> & {
    binaryControlObservation?: TransportBinaryControlObservation;
  } & EvObservedProbe & TemperatureObservedProbe
  & StateOfChargeObservedProbe & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
  & TransportControlBindingProbe;
