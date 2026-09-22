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
