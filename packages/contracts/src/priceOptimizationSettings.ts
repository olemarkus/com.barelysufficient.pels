/**
 * The price-optimization configuration facts needed by setup guidance.
 *
 * This is deliberately a projection rather than the persisted settings blob:
 * the price domain validates the SDK values and resolves configuration
 * presence before the value crosses the settings-UI API boundary.
 */
export type PriceOptimizationSetup = {
  readonly enabled: boolean;
  /** Every device with an explicit Price choice, including an explicit opt-out. */
  readonly configuredDeviceIds: readonly string[];
  /** Devices whose saved entry explicitly opts into solar-surplus use. */
  readonly solarSurplusDeviceIds: readonly string[];
};

export type PriceOptimizationSetupRead =
  | { readonly state: 'resolved'; readonly setup: PriceOptimizationSetup }
  | { readonly state: 'unavailable' };

/**
 * Fully resolved configuration for one device's Price and solar choices.
 * The shared settings reader classifies legacy omissions before consumers
 * receive the value; inward code never interprets field presence.
 */
export type PriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  /** The owner explicitly changed a Price control, including choosing Off. */
  priceConfigured: boolean;
  surplusWilling: boolean;
  surplusDelta: number;
};

export type PriceOptimizationConfigMapRead =
  | { state: 'resolved'; settings: Record<string, PriceOptimizationConfig> }
  | { state: 'unavailable' };
