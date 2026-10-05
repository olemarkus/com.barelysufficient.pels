import { EXPORT_FIXED, EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR } from '../utils/settingsKeys';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  resolveExportSchemeChangePlan,
  type ExportSchemeChangePlan,
} from '../../packages/shared-domain/src/settings/exportPriceSchemeChange';
import type { CombinedPriceFields, PriceScheme } from './priceTypes';

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

export type ExportPriceSettlement =
  | { readonly state: 'settled'; readonly plan: ExportSchemeChangePlan }
  | { readonly state: 'unavailable' };

const EXPORT_PRICE_KEYS = [EXPORT_PRICE_ENABLED, EXPORT_SPOT_FACTOR, EXPORT_FIXED] as const;

const finiteOr = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * Keep an export price from being read in another source's units when PELS
 * switches source by itself. The same rule the settings UI applies when the
 * owner switches source (`resolveExportSchemeChangePlan`), with the same
 * follow-up write, answering the plan applied for the caller to log.
 *
 * A missed read of a saved amount would read as 0 and could let a fixed amount
 * through in the wrong unit, so the settings are judged only when the key list
 * answers and every listed export key reads back. Otherwise the export price is
 * `unavailable` and the caller keeps the source it was entered under. A failed
 * write throws, with the same consequence.
 */
export const settleExportPriceForSourceChange = (
  settings: SettingsPort,
  previousScheme: PriceScheme,
  nextScheme: PriceScheme,
): ExportPriceSettlement => {
  const keys = readSettingsKeyList(settings);
  if (keys.status !== 'resolved') return { state: 'unavailable' };
  const stored = new Map<string, unknown>(EXPORT_PRICE_KEYS.map((key) => [key, settings.get(key)]));
  const unreadable = EXPORT_PRICE_KEYS.some((key) => keys.keys.includes(key) && stored.get(key) == null);
  if (unreadable) return { state: 'unavailable' };
  const config = readExportPriceConfig({
    getRaw: (key) => stored.get(key),
    getNumber: (key, fallback) => finiteOr(stored.get(key), fallback),
  });
  const plan = resolveExportSchemeChangePlan(
    previousScheme, nextScheme, config.enabled, config.spotFactorPercent, config.fixedInclVat,
  );
  if (plan === 'disable_export') settings.set(EXPORT_PRICE_ENABLED, false);
  if (plan === 'normalize_share') settings.set(EXPORT_SPOT_FACTOR, 0);
  return { state: 'settled', plan };
};

/**
 * Resolve the incl-VAT export price for one hour, or `undefined` when export is
 * disabled.
 *
 * `spotPriceExVat` / `vatMultiplier` are optional: when absent (no isolatable
 * spot, e.g. the flow/homey schemes) the spot term is 0 and the result is just
 * the fixed component — exactly the fixed-tariff (`spotFactorPercent = 0`) case.
 * The result may be <= 0; that is legitimate under feed-in fees / negative spot
 * and must NOT be clamped (the planning-price blend in `budgetPrice.ts` uses the
 * signed value; price levels never read it, they classify the import price).
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

/**
 * Layer export (feed-in) prices onto a combined hourly-price series, SCHEME-
 * INDEPENDENTLY. Export pricing is a decoration applied AFTER whichever import
 * scheme (Norway / flow / Homey) built the import series — it carries none of the
 * import cost stack and depends only on the export config plus each hour's
 * wholesale spot (when one is isolatable). Kept entirely separate from import
 * configuration: no import-scheme builder calls this, and this never branches on
 * the active scheme. No-op (returns the input untouched) when export pricing is
 * disabled, keeping non-prosumer behaviour byte-identical.
 *
 * Where no spot is isolatable (the flow/Homey schemes — e.g. NL), each entry's
 * `spotPriceExVat` is absent and `resolveExportPriceInclVat` yields the fixed
 * feed-in tariff for a fixed-tariff config (`spotFactorPercent = 0`) and no
 * export price for a spot-linked one — exactly as documented above.
 */
export const applyExportPrices = <T extends CombinedPriceFields>(
  prices: T[],
  config: ExportPriceConfig,
): T[] => {
  if (!config.enabled) return prices;
  return prices.map((entry) => {
    const exportPrice = resolveExportPriceInclVat({
      spotPriceExVat: entry.spotPriceExVat,
      vatMultiplier: entry.vatMultiplier,
      config,
    });
    return typeof exportPrice === 'number' ? { ...entry, exportPrice } : entry;
  });
};
