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
 * The quantity an objective measures progress in, with the time it was measured.
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
export type ObjectiveObservedQuantity = Pick<
  DeviceObjectiveProfileSample,
  'observedAtMs' | 'value'
>;

// Exactly what resolution reads, and nothing else: the kind predicate's two
// descriptor fields plus the two observed facets. Deliberately NOT the whole
// `ObservedDeviceState` — a caller should not have to supply an unrelated device
// shape to ask this question.
export type ObjectiveQuantityDevice =
  & Pick<DeviceDescriptor, 'deviceClass' | 'deviceType'>
  & TemperatureObservedProbe
  & StateOfChargeObservedProbe;

/**
 * Resolves the device's measured quantity, or `null` when it has none.
 *
 * `observedAtMs` is non-null by construction: a value and its timestamp arrive
 * together, so there is no "measured but un-timed" state for a consumer to model
 * or defend against. A device with no reading at all resolves to `null` — that is
 * the one real absence, and it is the whole absence.
 *
 * Temperature takes precedence over SoC for a device reporting both, matching the
 * order the sampler used when this was two branches.
 *
 * `deviceObservedAtMs` is the device-level stamp (Homey's highest per-capability
 * `lastUpdated`), needed only for temperature: `TemperatureObservation` carries no
 * stamp of its own, while a SoC snapshot does.
 */
export function resolveObjectiveObservedQuantity(params: {
  device: ObjectiveQuantityDevice;
  deviceObservedAtMs: number | undefined;
}): ObjectiveObservedQuantity | null {
  const { device, deviceObservedAtMs } = params;

  if (
    isTemperatureControlDevice(device)
    && hasObservedTemperature(device)
    && deviceObservedAtMs !== undefined
  ) {
    return {
      observedAtMs: deviceObservedAtMs,
      // Tenths: the profile's rise thresholds are in tenths of a degree, and an
      // un-rounded sensor value would make two identical readings compare unequal.
      value: Math.round(device.temperature.currentTemperature * 10) / 10,
    };
  }

  if (hasObservedStateOfCharge(device)) {
    // `level` answers usability, and no `Number.isFinite` re-check follows it —
    // the producer stands behind the level or reports none.
    const { level, observedAtMs } = device.stateOfCharge;
    if (level.kind !== 'known' || observedAtMs === undefined) return null;
    return { observedAtMs, value: level.percent };
  }

  return null;
}
