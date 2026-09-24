export type PriceOptimizationSettings = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  // Surplus-absorb rides this same per-device blob (a distinct cause from price —
  // triggered by exporting, not a cheap hour). `surplusWilling` opts the device in;
  // `surplusDelta` is the raise-only setpoint lift (°C). The settings adapter
  // resolves legacy omissions before this value reaches business logic.
  surplusWilling: boolean;
  surplusDelta: number;
};

/**
 * One device's price-optimization entry with nothing left to interpret: a
 * device with no entry is not price-aware and has no lift, and a lift the owner
 * did not opt into, or one that is not a positive number, is no lift.
 */
export type ResolvedPriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  /** The surplus setpoint lift in °C; 0 for a device with no lift. */
  surplusLiftC: number;
};

const NOT_PRICE_AWARE: ResolvedPriceOptimizationConfig = {
  enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusLiftC: 0,
};

export function resolvePriceOptimizationConfig(
  settings: Readonly<Record<string, PriceOptimizationSettings>>,
  deviceId: string,
): ResolvedPriceOptimizationConfig {
  // Own keys only: a device id naming an Object.prototype member has no entry.
  if (!Object.hasOwn(settings, deviceId)) return NOT_PRICE_AWARE;
  const { enabled, cheapDelta, expensiveDelta, surplusWilling, surplusDelta } = settings[deviceId]!;
  const lifts = surplusWilling && surplusDelta > 0;
  return { enabled, cheapDelta, expensiveDelta, surplusLiftC: lifts ? surplusDelta : 0 };
}
