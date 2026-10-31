import type { BatteryEnergyHorizon, BatteryEnergyPeriod } from '../../packages/contracts/src/batteryPlan';
import type {
  ContinuousBatteryPlanConfig,
  ContinuousBatteryPlanWaitReason,
} from '../../packages/contracts/src/continuousBatteryPlan';

/** Resolved household horizon supplied by planInput; battery owns its economic decision. */
export type ContinuousBatteryEnergyHorizon = BatteryEnergyHorizon & {
  periods: readonly [BatteryEnergyPeriod, ...BatteryEnergyPeriod[]];
};

export type ContinuousBatteryHorizonRead =
  | {
    kind: 'ready';
    horizon: ContinuousBatteryEnergyHorizon;
    priceUnit: string;
    /** Every represented period has an actual export quote; household-only zero stand-ins do not count. */
    exportPricing: 'complete' | 'incomplete';
  }
  | { kind: 'waiting'; reason: ContinuousBatteryPlanWaitReason };

export type ContinuousBatteryPlanSource = {
  getNowMs(): number;
  readHorizon(deviceId: string, config: ContinuousBatteryPlanConfig): ContinuousBatteryHorizonRead;
};
