import type { PriceOptimizationConfig } from '../../../contracts/src/priceOptimizationSettings.ts';
import { DEFAULT_SURPLUS_LIFT_C } from '../../../shared-domain/src/settings/priceOptimization.ts';

export const DEFAULT_PRICE_OPTIMIZATION_CONFIG: PriceOptimizationConfig = {
  enabled: false,
  cheapDelta: 5,
  expensiveDelta: -5,
  priceConfigured: false,
  surplusWilling: false,
  surplusDelta: DEFAULT_SURPLUS_LIFT_C,
};
