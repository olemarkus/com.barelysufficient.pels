import type { EnergyBucket } from '../power/energyAccounting';
import { getZonedParts } from '../../packages/shared-domain/src/utils/dateUtils';

export type ObservedWindowBucketUsage = {
  hour: number;
  controlled: number;
  uncontrolled: number;
  grossUncontrolled: number;
};

export const resolveWindowBucketUsage = (
  key: string,
  energy: EnergyBucket,
  timeZone: string,
  windowStartUtcMs: number,
  windowEndUtcMs: number,
): ObservedWindowBucketUsage | null => {
  const ts = new Date(key).getTime();
  if (!Number.isFinite(ts) || ts < windowStartUtcMs || ts >= windowEndUtcMs) return null;
  if (energy.measurement === 'unrecorded') return null;
  const { controlled, background: uncontrolled } = energy.counted;
  const grossUncontrolled = energy.countedGross.background;
  if (controlled <= 0 && uncontrolled <= 0 && grossUncontrolled <= 0) return null;
  return { hour: getZonedParts(new Date(ts), timeZone).hour, controlled, uncontrolled, grossUncontrolled };
};
