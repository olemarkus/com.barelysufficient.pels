import { isTemperatureControlDevice } from './temperatureDeviceKind';
import { hasObservedTemperature } from './temperatureObservedState';
import { hasObservedStateOfCharge } from './stateOfChargeObservedState';
import type { DeviceObjectiveProfileSample } from '../../contracts/src/objectiveProfileTypes';
import type {
  DeviceDescriptor,
  StateOfChargeObservedProbe,
  TemperatureObservedProbe,
} from '../../contracts/src/types';

/**
 * The quantity an objective measures progress in.
 *
 * Temperature and state-of-charge are the SAME thing — a value that rises toward
 * a target — and nothing downstream is told which it was. There is no unit here:
 * `lib/objectives` holds no concept of one, and everything in it is state of
 * charge even when the charge is heat. Only what feeds this seam, and the UI that
 * renders it, know what the number really is.
 *
 * This is the observation half of a `DeviceObjectiveProfileSample`; the power half
 * is resolved separately, from the device's draw.
 */
export type ObjectiveObservedQuantity = Pick<DeviceObjectiveProfileSample, 'value'>;

// Exactly what resolution reads, and nothing else: the kind predicate's two
// descriptor fields plus the two observed facets. Deliberately NOT the whole
// `ObservedDeviceState` — a caller should not have to supply an unrelated device
// shape to ask this question.
export type ObjectiveQuantityDevice =
  & Pick<DeviceDescriptor, 'deviceClass' | 'deviceType'>
  & TemperatureObservedProbe
  & StateOfChargeObservedProbe;

/**
 * Resolves the device's measured quantity, or `null` when it has none. A device
 * with no reading at all is the one real absence, and it is the whole absence.
 * No observation time travels with it: freshness is settled at the observer.
 *
 * SoC takes precedence over temperature for a device reporting both, matching
 * `resolveSmartTaskDeviceKind` ("EV chargers win over the temperature branch").
 * The two classifiers must not disagree: with the profile's kind guard gone there
 * is nothing downstream to catch it, and a kWh/°C rate consumed as kWh/% would
 * mis-size the whole deadline plan.
 */
export function resolveObjectiveObservedQuantity(
  device: ObjectiveQuantityDevice,
): ObjectiveObservedQuantity | null {

  if (hasObservedStateOfCharge(device)) {
    // `level` answers usability, and no `Number.isFinite` re-check follows it —
    // the producer stands behind the level or reports none.
    const { level } = device.stateOfCharge;
    if (level.kind !== 'known') return null;
    return { value: level.percent };
  }

  if (isTemperatureControlDevice(device) && hasObservedTemperature(device)) {
    return {
      // Tenths: the profile's rise thresholds are in tenths of a degree, and an
      // un-rounded sensor value would make two identical readings compare unequal.
      value: Math.round(device.temperature.currentTemperature * 10) / 10,
    };
  }

  return null;
}
