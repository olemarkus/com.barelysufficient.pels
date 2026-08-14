import type {
  TemperatureObservedFields,
  TemperatureObservedProbe,
} from '../../contracts/src/types';

/**
 * Narrows an observer value to its atomic temperature facet. Presence is the
 * type: the producer attaches it only when the exact `measure_temperature` and
 * `target_temperature` values are both finite. This guard does not validate or
 * interpret a kind tag; consumers trust the boundary and read both required
 * values directly.
 */
export const hasObservedTemperature = <T extends TemperatureObservedProbe>(
  snapshot: T,
): snapshot is T & TemperatureObservedFields => (
  snapshot.temperature !== undefined
);
