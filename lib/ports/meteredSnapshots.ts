import type {
  MeteredPowerReading,
  MeasuredPowerObservedFields,
  MeasuredPowerObservedProbe,
} from '../../packages/contracts/src/types';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';

// Neutral typed boundary used by setup to pass only trusted meter-bearing
// snapshots between otherwise independent device, plan, and objective domains.

export const asMeteredSnapshot = <T extends MeasuredPowerObservedProbe>(
  snapshot: T,
): (T & MeasuredPowerObservedFields) | undefined => (
  hasObservedMeasuredPower(snapshot) ? snapshot : undefined
);

export const selectMeteredSnapshots = <T extends MeasuredPowerObservedProbe>(
  snapshots: readonly T[],
): Array<T & MeasuredPowerObservedFields> => snapshots.filter(hasObservedMeasuredPower);

export type MeteredDeviceReading = MeteredPowerReading & { deviceId: string };

/**
 * Resolve the trusted, time-bearing meter records used for delivery accounting.
 * A retained snapshot repeats the same record verbatim; consumers deduplicate by
 * its source timestamp rather than mistaking a lifecycle tick for a new sample.
 */
export const selectMeteredDeviceReadings = <T extends {
  id: string;
  measuredPowerReading?: MeteredPowerReading;
}>(snapshots: readonly T[]): MeteredDeviceReading[] => snapshots.flatMap((snapshot) => (
    snapshot.measuredPowerReading === undefined
      ? []
      : [{ deviceId: snapshot.id, ...snapshot.measuredPowerReading }]
));
