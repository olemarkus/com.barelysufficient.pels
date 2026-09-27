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
  ThermostatModeObservedProbe,
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
 * - `TemperatureObservedProbe` for the atomic current/target temperature facet (see
 *   `TemperatureObservedFields`).
 * - `StateOfChargeObservedProbe` for `stateOfCharge` (see
 *   `StateOfChargeObservedFields`).
 * - `MeasuredPowerObservedProbe` for `measuredPowerKw` /
 *   `measuredPowerObservedAtMs` (see `MeasuredPowerObservedFields`), beside the
 *   transport's own `measuredPowerReading` and `measuredPowerSource`.
 * - `SteppedLoadDescriptorProbe` for `steppedLoadProfile` / `targetPowerConfig`
 *   (see `SteppedLoadDescriptorFields`).
 * - `ReportedStepObservedProbe` for `reportedStepId` and exact target-power
 *   evidence.
 *
 * This shape is for the transport/observer OWNER seams only. It must not leak
 * across the producer boundary — consumers receive `TargetDeviceSnapshot` (the
 * widened object is assignable to it) and narrow through `isEvObserved` /
 * `hasObservedTemperature` / `hasObservedStateOfCharge` /
 * `hasObservedMeasuredPower` / `isSteppedLoadSnapshot`
 * (`packages/shared-domain/src/*ObservedState.ts`).
 */
/**
 * Time semantics for a trusted device-meter result, private to the device layer
 * (retained-power persistence and the observation merge read it; nothing past
 * the transport does). Direct watt readings are point observations whose value
 * applies until the next observation. A cumulative energy meter resolves an
 * average over the exact interval between its two source observations.
 */
export type MeteredPowerReading =
  | { kind: 'instantaneous'; powerKw: number; observedAtMs: number }
  | { kind: 'interval_average'; powerKw: number; startMs: number; endMs: number };

/**
 * Where a device's measured power came from, in the resolver's order of
 * preference: the device's own `measure_power`, a rate derived from its
 * cumulative `meter_power`, or Homey Energy's live figure for it. Private to
 * the device layer like the reading above: consumers are told only what it
 * means (`measuredPowerIsDirectMeasurement`, `projectObservedState`), so none
 * branches on a capability id.
 */
export type MeasuredPowerSource = 'measure_power' | 'meter_power' | 'homey_energy';

export type TransportDeviceSnapshot =
  Omit<TargetDeviceSnapshot, 'binaryControlObservation'> & {
    binaryControlObservation?: TransportBinaryControlObservation;
    measuredPowerReading?: MeteredPowerReading;
    /** Written with every `measuredPowerKw`, by the same seams. */
    measuredPowerSource?: MeasuredPowerSource;
  } & EvObservedProbe & TemperatureObservedProbe & ThermostatModeObservedProbe
  & StateOfChargeObservedProbe & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
  & TransportControlBindingProbe;
