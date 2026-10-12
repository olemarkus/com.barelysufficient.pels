/**
 * Everything the Homey Energy price source needs, behind one door.
 *
 * Pricing a Homey home takes three readings of the owner's Homey configuration
 * — the import formula, their choice of feed-in source, and Homey's own export
 * terms — and they are only ever used together, in two places: the periodic
 * refresh that mirrors them, and the series build that applies them. Composing
 * them here keeps `PriceService` holding one collaborator for this scheme
 * instead of the pieces it is made of.
 */

import type { SettingsPort } from '../ports/homeyRuntime';
import {
  EXPORT_PRICE_ENABLED, EXPORT_PRICE_SOURCE, HOMEY_PRICE_FORMULA,
} from '../utils/settingsKeys';
import {
  isExportPriceSourceSetting,
  readExportPriceSourceSetting,
} from '../../packages/shared-domain/src/settings/exportPriceSource';
import type { CombinedPricePeriod, PriceScheme } from './priceTypes';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';
import type { HomeyWebApiGet } from './homeyWebApiPort';
import {
  readStoredPriceFormula,
  resolveHomeyPriceSeries,
  syncHomeyPriceFormula,
  type HomeyPriceResolution,
} from './homeyPriceFormula';
import type { HomeyPriceFormulaUiStatus } from '../../packages/contracts/src/settingsUiApi';
import {
  hasMirroredExportTerms, readExportTerms, resolveHomeyExportPrice, syncHomeyExportTerms,
} from './homeyExportPrice';
import { readExportPriceConfig, EXPORT_PRICE_DISABLED, type ExportPriceConfig } from './exportPrice';

import { dropsPersistedPrices } from './homeyPriceFormula';

export type { HomeyPriceResolution } from './homeyPriceFormula';

/**
 * Whether Homey's own terms are what PELS should pay the owner for export.
 *
 * Three conditions, and all of them are the owner's own settings:
 *
 * 1. Export pricing is ON. The source selector says WHERE the price comes
 *    from; the master toggle says WHETHER the owner is paid at all, and a
 *    source cannot outrank it — turning the feature off has to stop the
 *    planner valuing exported solar, whichever source it came from.
 * 2. The price source is Homey Energy. Only the Homey series carries Homey's
 *    feed-in price, so on any other import scheme these terms would take the
 *    owner's own amounts out of play and put nothing in their place. The
 *    stored choice is left alone across a scheme change — switching back
 *    restores it rather than silently rewriting what the owner picked.
 * 3. The owner chose Homey as the source.
 *
 * A source key that is LISTED but reads back unusable settles nothing, so it
 * falls back to the second witness: mirrored terms exist only where the source
 * was Homey when they were written.
 */
export const usesHomeyExportTerms = (settings: SettingsPort, scheme: PriceScheme): boolean => {
  if (settings.get(EXPORT_PRICE_ENABLED) !== true) return false;
  if (scheme !== 'homey') return false;
  const stored = settings.get(EXPORT_PRICE_SOURCE);
  if (isExportPriceSourceSetting(stored)) return stored === 'homey_energy';
  const listed = settings.getKeys().includes(EXPORT_PRICE_SOURCE);
  return listed ? hasMirroredExportTerms(settings) : readExportPriceSourceSetting(stored) === 'homey_energy';
};

/**
 * Mirror the owner's Homey pricing configuration, reporting whether any of it
 * moved — the caller's cue to rebuild the series it is holding.
 *
 * Homey's export terms are read only when they are the ones PELS would apply:
 * three requests per refresh for terms the owner has not chosen is work for
 * nothing.
 */
export const syncHomeyPricing = async (
  webApiGet: HomeyWebApiGet,
  settings: SettingsPort,
  scheme: PriceScheme,
  sinks: PriceServiceLoggingSinks,
): Promise<boolean> => {
  const formulaChanged = await syncHomeyPriceFormula(webApiGet, settings, sinks);
  const exportChanged = usesHomeyExportTerms(settings, scheme)
    && await syncHomeyExportTerms(webApiGet, settings, sinks);
  return formulaChanged || exportChanged;
};

/**
 * The published Homey series, priced: raw spot resolved through the owner's
 * import formula, with Homey's feed-in price attached per period when that is
 * where the owner's export price comes from.
 */
export const resolveHomeySeries = (
  periods: CombinedPricePeriod[],
  settings: SettingsPort,
  scheme: PriceScheme,
): HomeyPriceResolution => {
  if (!usesHomeyExportTerms(settings, scheme)) return resolveHomeyPriceSeries(periods, settings);
  // Terms that are mirrored but unreadable right now would silently drop the
  // feed-in price out of an otherwise good series. Price the import side as
  // usual, but mark the build undecided so nothing persists the loss.
  if (readExportTerms(settings).kind === 'suspect') {
    const resolution = resolveHomeyPriceSeries(periods, settings);
    return { ...resolution, verdict: 'undecided', reasonCode: 'unreadable_export_terms' };
  }
  return resolveHomeyPriceSeries(
    periods,
    settings,
    (spot, importPrice) => resolveHomeyExportPrice(settings, spot, importPrice),
  );
};

/**
 * Which export model decorates the series.
 *
 * When Homey's terms are the source, the feed-in price is already attached per
 * period by {@link resolveHomeySeries} — where a period's raw spot and resolved
 * import price both exist — so PELS's own export model sits this one out rather
 * than overwriting what Homey said.
 */
export const resolveExportConfigForScheme = (
  settings: SettingsPort,
  scheme: PriceScheme,
  getRaw: (key: string) => unknown,
  getNumber: (key: string, fallback: number) => number,
): ExportPriceConfig => (
  usesHomeyExportTerms(settings, scheme)
    ? EXPORT_PRICE_DISABLED
    : readExportPriceConfig({ getRaw, getNumber })
);

/**
 * Whether this rebuild must leave the persisted prices alone.
 *
 * Two reasons, and they are not the same:
 *
 * - The build is UNDECIDED — a failed read left it incomplete, so nothing
 *   about it may become durable or a hiccup persists as a price.
 * - The rebuild came back empty while good prices are stored, which normally
 *   means a raw slot was briefly unreadable. `dropsPersistedPrices` overrides
 *   that for the one case where the emptiness is a verdict.
 */
export const keepsPersistedPrices = (
  homeyPrices: HomeyPriceResolution | null,
  sinks: PriceServiceLoggingSinks,
  rebuildLostEntries: () => boolean,
): boolean => {
  if (homeyPrices?.verdict === 'undecided') {
    sinks.debugStructured({
      event: 'combined_prices_rebuild_kept_cache',
      reasonCode: homeyPrices.reasonCode,
    });
    return true;
  }
  if (homeyPrices && dropsPersistedPrices(homeyPrices, sinks)) return false;
  if (!rebuildLostEntries()) return false;
  sinks.debugStructured({ event: 'combined_prices_rebuild_kept_cache', reasonCode: 'lost_actionable_entries' });
  return true;
};

/**
 * How the owner's Homey price setup looks from the settings UI.
 *
 * The UI cannot read the mirror itself — it holds runtime bytes with a runtime
 * read policy — and a home with no prices otherwise shows an unexplained
 * blank. This resolves the state here, in the module that owns it, and the UI
 * only chooses words for it.
 */
export const resolveHomeyPriceFormulaUiStatus = (
  settings: SettingsPort,
  scheme: PriceScheme,
  resolution: HomeyPriceResolution,
): HomeyPriceFormulaUiStatus => {
  // `scheme` is the source in force. A scheme key that reads back unusable
  // keeps the source last in force (`PriceSchemeResolver`), so a home on Homey
  // Energy still gets its explanation through a transient miss.
  if (scheme !== 'homey') return { kind: 'none' };
  const stored = readStoredPriceFormula(settings);
  const expression = stored.kind === 'unsupported' ? stored.expression : '';
  if (stored.kind === 'unsupported') return { kind: 'unsupported', expression };
  // The live verdict, not merely whether the text parsed: a formula can compile
  // and still price no hour at all, and the owner sees the same blank series.
  if (resolution.verdict === 'unpriceable' && resolution.reasonCode === 'nothing_priced') {
    return { kind: 'prices_nothing', expression: storedExpression(settings) };
  }
  if (resolution.verdict === 'undecided' || stored.kind === 'unknown' || stored.kind === 'unreadable') {
    return { kind: 'unknown' };
  }
  return stored.kind === 'compiled' ? { kind: 'applied' } : { kind: 'none' };
};

/** The mirrored expression as written, for a message that quotes it back. */
const storedExpression = (settings: SettingsPort): string => {
  const stored = readStoredPriceFormula(settings);
  if (stored.kind === 'unsupported') return stored.expression;
  const raw = settings.get(HOMEY_PRICE_FORMULA);
  const mathExpression = typeof raw === 'object' && raw !== null
    ? (raw as { mathExpression?: unknown }).mathExpression
    : null;
  return typeof mathExpression === 'string' ? mathExpression : '';
};
