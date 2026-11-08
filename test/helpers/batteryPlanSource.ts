import type { ContinuousBatteryPlanConfig } from '../../packages/contracts/src/continuousBatteryPlan';
import type { ContinuousBatteryHorizonRead, ContinuousBatteryPlanSource } from '../../lib/ports/continuousBatteryPlan';

/**
 * A plan source from one horizon read per battery, in the order the batteries
 * are listed: the plan owner orders and reads them as production does.
 */
export type PerBatterySourceInput = {
  getNowMs: () => number;
  readHorizon: (deviceId: string, config: ContinuousBatteryPlanConfig) => ContinuousBatteryHorizonRead;
  order?: readonly string[];
};

export const perBatterySource = (input: PerBatterySourceInput): ContinuousBatteryPlanSource => ({
  getNowMs: input.getNowMs,
  orderByPriority: (deviceIds) => {
    const order = input.order ?? [];
    const rank = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length);
    return [...deviceIds].sort((left, right) => rank(left) - rank(right));
  },
  readHorizons: (_nowMs, batteries) => new Map(
    batteries.map(({ deviceId, config }) => [deviceId, input.readHorizon(deviceId, config)]),
  ),
});
