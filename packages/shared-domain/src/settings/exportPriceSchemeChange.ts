import type { PriceSchemeSetting } from '../../../contracts/src/settingsUiApi.js';

/**
 * What a change of price source does to an enabled export price.
 *
 * Crossing the Norway unit boundary changes what an enabled export config
 * means, in EITHER direction:
 *   • A non-zero fixed amount was entered in the unit of the source that was
 *     in force at the time: øre/kWh (divisor 100) on Norway, the source unit
 *     (divisor 1) on Flow, Homey Energy and Power by the Hour. Carried raw
 *     across the boundary, "−5 øre" becomes "−5 source-units" and "0.50 NOK"
 *     is re-read as "0.50 øre" (100× off). Export pricing turns OFF instead;
 *     the stored numbers stay inert so returning to the entry source only
 *     needs a re-enable.
 *   • A pure spot-share config (fixed = 0) is a unitless percent, so it crosses
 *     safely, but a spot-linked share without an isolatable spot yields NO
 *     export price at all (`lib/price/exportPrice.ts`), so entering a
 *     spot-less source normalizes the share to 0. Entering Norway a stored
 *     share is meaningful again: no action.
 *
 * Both sides apply it: the settings UI when the owner switches source, and the
 * runtime when it switches the source it assumed from the hub's country.
 * `previousScheme` must be the source the stored amounts were entered under.
 */
export type ExportSchemeChangePlan = 'none' | 'disable_export' | 'normalize_share';

export const resolveExportSchemeChangePlan = (
  previousScheme: PriceSchemeSetting,
  nextScheme: PriceSchemeSetting,
  exportPriceEnabled: boolean,
  exportSpotFactor: number,
  exportFixed: number,
): ExportSchemeChangePlan => {
  if (!exportPriceEnabled) return 'none';
  const crossesUnitBoundary = (previousScheme === 'norway') !== (nextScheme === 'norway');
  if (crossesUnitBoundary && exportFixed !== 0) return 'disable_export';
  if (nextScheme !== 'norway' && exportSpotFactor !== 0) return 'normalize_share';
  return 'none';
};
