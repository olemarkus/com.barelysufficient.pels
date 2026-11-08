import type { BatteryEnergyHorizon, BatteryEnergyPeriod } from '../../packages/contracts/src/batteryPlan';
import type {
  ContinuousBatteryPlanConfig,
  ContinuousBatteryPlanWaitReason,
} from '../../packages/contracts/src/continuousBatteryPlan';

/** Resolved household horizon supplied by planInput; battery owns its economic decision. */
export type ContinuousBatteryEnergyHorizon = BatteryEnergyHorizon & {
  periods: readonly [BatteryEnergyPeriod, ...BatteryEnergyPeriod[]];
};

export type ContinuousBatteryExportPricing = 'complete' | 'incomplete' | 'unpriced_solar';

export type ContinuousBatteryHorizonRead =
  | {
    kind: 'ready';
    horizon: ContinuousBatteryEnergyHorizon;
    priceUnit: string;
    /**
     * `complete`: every represented period has an actual export quote.
     * `incomplete`: some period has none; household planning reads it as 0,
     * which cannot change its objective because it has no solar to export.
     * `unpriced_solar`: some period with forecast solar has none, so household
     * planning values that solar's export at 0 and prefers storing it.
     * Only `complete` may authorize selling; a zero stand-in is never a quote.
     */
    exportPricing: ContinuousBatteryExportPricing;
  }
  | { kind: 'waiting'; reason: ContinuousBatteryPlanWaitReason };

export type ContinuousBatteryPlanSource = {
  getNowMs(): number;
  /** These batteries in the owner's priority order, highest priority first. */
  orderByPriority(deviceIds: readonly string[]): readonly string[];
  /**
   * Each battery's horizon from one set of reads at `nowMs`. Every ready
   * horizon has the same periods, before any battery's plan is applied.
   */
  readHorizons(
    nowMs: number,
    batteries: readonly { deviceId: string; config: ContinuousBatteryPlanConfig }[],
  ): ReadonlyMap<string, ContinuousBatteryHorizonRead>;
};
