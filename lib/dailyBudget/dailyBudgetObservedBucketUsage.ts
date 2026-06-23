import { resolveAttributionSplit } from '../../packages/shared-domain/src/dailyBudget/attributionSplit';
import { getZonedParts } from '../utils/dateUtils';

export type ObservedWindowBucketUsage = {
  hour: number;
  controlled: number;
  uncontrolled: number;
  grossUncontrolled: number;
};

export const resolveWindowBucketUsage = (params: {
  key: string;
  totalRaw: unknown;
  controlledBuckets: Record<string, number>;
  uncontrolledBuckets: Record<string, number>;
  exemptBuckets: Record<string, number>;
  timeZone: string;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
}): ObservedWindowBucketUsage | null => {
  const {
    key,
    totalRaw,
    controlledBuckets,
    uncontrolledBuckets,
    exemptBuckets,
    timeZone,
    windowStartUtcMs,
    windowEndUtcMs,
  } = params;
  const ts = new Date(key).getTime();
  if (!Number.isFinite(ts) || ts < windowStartUtcMs || ts >= windowEndUtcMs) return null;
  if (typeof totalRaw !== 'number' || !Number.isFinite(totalRaw)) return null;
  const total = Math.max(0, totalRaw);
  const controlledRaw = controlledBuckets[key];
  const uncontrolledRaw = uncontrolledBuckets[key];
  const exemptRaw = exemptBuckets[key];
  const netSplit = resolveNetObservedSplit({ total, controlledRaw, uncontrolledRaw, exemptRaw });
  const grossSplit = resolveAttributionSplit({
    totalNet: total,
    controlledGross: controlledRaw,
    uncontrolledGross: uncontrolledRaw,
  });
  const grossUncontrolled = grossSplit.uncontrolled ?? netSplit.uncontrolled;
  if (netSplit.controlled <= 0 && netSplit.uncontrolled <= 0 && grossUncontrolled <= 0) return null;
  return {
    hour: getZonedParts(new Date(ts), timeZone).hour,
    controlled: netSplit.controlled,
    uncontrolled: netSplit.uncontrolled,
    grossUncontrolled,
  };
};

const resolveNetObservedSplit = (params: {
  total: number;
  controlledRaw: unknown;
  uncontrolledRaw: unknown;
  exemptRaw: unknown;
}): { controlled: number; uncontrolled: number } => {
  const { total, controlledRaw, uncontrolledRaw, exemptRaw } = params;
  let controlled = 0;
  let uncontrolled = total;

  if (typeof controlledRaw === 'number' && Number.isFinite(controlledRaw)) {
    const exempt = typeof exemptRaw === 'number' && Number.isFinite(exemptRaw)
      ? Math.max(0, Math.min(exemptRaw, total))
      : 0;
    controlled = Math.max(0, Math.min(controlledRaw - exempt, total));
    uncontrolled = Math.max(0, total - controlled);
  } else if (typeof uncontrolledRaw === 'number' && Number.isFinite(uncontrolledRaw)) {
    uncontrolled = Math.max(0, Math.min(uncontrolledRaw, total));
    controlled = Math.max(0, total - uncontrolled);
  }

  return { controlled, uncontrolled };
};
