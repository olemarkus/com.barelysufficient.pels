import type { ContinuousBatteryPlanRead } from '../../packages/contracts/src/continuousBatteryPlan';
import type { HomeBatteryLevelObservation } from '../../packages/contracts/src/types';

/**
 * The discharge a battery plan's configured reserve allows within the hour, in
 * watts. It constrains both economic and capacity discharge. An unread level
 * cannot authorize stored-energy use, so it allows none; without a plan the
 * owner's delivery ceiling stands.
 */
export const continuousReserveCeilingW = (
  continuous: ContinuousBatteryPlanRead,
  level: HomeBatteryLevelObservation | undefined,
  deliveryCeilingW: number,
): number => {
  if (!continuous.config.enabled) return deliveryCeilingW;
  if (level === undefined) return 0;
  return Math.max(0, level.percent - continuous.config.minimumReservePercent)
    * continuous.config.usableCapacityKWh * 10 * Math.sqrt(continuous.config.roundTripEfficiency);
};
