import type { MeteredPowerReading } from '../transportDeviceSnapshot';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

const endMs = (reading: MeteredPowerReading): number => (
  reading.kind === 'instantaneous' ? reading.observedAtMs : reading.endMs
);

/** Preserve the complete source record when a pull predates committed telemetry. */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function preserveNewerMeteredPowerReading(
  previous: TransportDeviceSnapshot,
  next: TransportDeviceSnapshot,
): void {
  const retained = previous.measuredPowerReading;
  const incoming = next.measuredPowerReading;
  // Admission/absence is resolved by the parser; a removed meter stays removed.
  if (retained === undefined || incoming === undefined || endMs(retained) <= endMs(incoming)) return;
  const snapshot = next;
  snapshot.measuredPowerReading = retained;
  snapshot.measuredPowerKw = retained.powerKw;
  snapshot.measuredPowerObservedAtMs = previous.measuredPowerObservedAtMs;
  snapshot.measuredPowerSource = previous.measuredPowerSource;
}
/* eslint-enable functional/immutable-data */
