import { EXPORT_FIXED, EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR } from '../utils/settingsKeys';

/**
 * Export (feed-in) price model.
 *
 * Export price is pure math on the SAME wholesale spot the import price uses,
 * plus export-specific terms the user enters from their feed-in contract. It
 * carries NONE of the import cost stack (grid tariff / consumption tax / Enova) —
 * only the (VAT-grossed) spot scaled by `spotFactorPercent` plus a fixed
 * incl-VAT component. `spotFactorPercent === 0` ⇒ a pure fixed tariff that needs
 * no spot at all, which is the only mode available where no spot is isolatable
 * (the flow/homey schemes, e.g. NL — see the spec's market notes).
 */
export type ExportPriceConfig = {
  /** Master toggle; when false, no export price is produced. */
  enabled: boolean;
  /**
   * How much the spot affects the export price, as a percent.
   * `0` = spot-independent fixed tariff; `100` = full spot pass-through;
   * `~90` = NO plusskunde (≈90% of spot).
   */
  spotFactorPercent: number;
  /** Flat per-kWh component, incl VAT, SIGNED (negative ⇒ you pay to export). */
  fixedInclVat: number;
};

export const EXPORT_PRICE_DISABLED: ExportPriceConfig = {
  enabled: false,
  spotFactorPercent: 0,
  fixedInclVat: 0,
};

/**
 * Resolve the export config from settings. Off by default (returns the disabled
 * sentinel) so the producer emits no `exportPrice` and behaviour is byte-identical
 * to today. CLI-writable for dogfooding before the settings UI lands. Takes an
 * abstract reader so it stays free of the Homey SDK.
 */
export const readExportPriceConfig = (read: {
  getRaw: (key: string) => unknown;
  getNumber: (key: string, fallback: number) => number;
}): ExportPriceConfig => {
  if (read.getRaw(EXPORT_PRICE_ENABLED) !== true) return EXPORT_PRICE_DISABLED;
  return {
    enabled: true,
    spotFactorPercent: read.getNumber(EXPORT_SPOT_FACTOR, 0),
    fixedInclVat: read.getNumber(EXPORT_FIXED, 0),
  };
};

const finiteOr = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * Resolve the incl-VAT export price for one hour, or `undefined` when export is
 * disabled.
 *
 * `spotPriceExVat` / `vatMultiplier` are optional: when absent (no isolatable
 * spot, e.g. the flow/homey schemes) the spot term is 0 and the result is just
 * the fixed component — exactly the fixed-tariff (`spotFactorPercent = 0`) case.
 * The result may be <= 0; that is legitimate under feed-in fees / negative spot
 * and must NOT be clamped (callers that classify price levels handle the sign).
 */
export const resolveExportPriceInclVat = (params: {
  spotPriceExVat?: number;
  vatMultiplier?: number;
  config: ExportPriceConfig;
}): number | undefined => {
  const { spotPriceExVat, vatMultiplier, config } = params;
  if (!config.enabled) return undefined;
  const factor = finiteOr(config.spotFactorPercent, 0) / 100;
  const fixed = finiteOr(config.fixedInclVat, 0);
  // A spot-linked tariff (factor != 0) genuinely needs a spot. If the spot is
  // missing or non-finite, report "no export price" rather than silently
  // collapsing to the fixed component alone, which would emit a misleading
  // price. A pure fixed tariff (factor == 0) ignores the spot and is unaffected.
  if (factor !== 0 && !Number.isFinite(spotPriceExVat)) return undefined;
  const spotInclVat = finiteOr(spotPriceExVat, 0) * finiteOr(vatMultiplier, 1);
  const result = spotInclVat * factor + fixed;
  // A non-finite result (e.g. an absurd spot factor overflowing to Infinity)
  // would be attached in memory but dropped by the finite-only persist guard,
  // desyncing the live and stored seams — collapse it to "no export price".
  return Number.isFinite(result) ? result : undefined;
};
