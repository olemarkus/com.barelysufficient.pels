import type {
  EvObservedProbe,
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  StateOfChargeObservedProbe,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';

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
 * - `ReportedStepObservedProbe` for `reportedStepId` (see
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
  TargetDeviceSnapshot & EvObservedProbe & TemperatureObservedProbe
  & StateOfChargeObservedProbe & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe & ReportedStepObservedProbe;
