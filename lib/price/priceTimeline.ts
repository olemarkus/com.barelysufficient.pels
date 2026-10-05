import type { PriceTimeline } from '../../packages/contracts/src/priceTimeline';
import { applyExportPrices, type ExportPriceConfig } from './exportPrice';
import { resolvePriceLevelTimeline, type PriceLevelBand } from './priceLevelUtils';
import type { CombinedPricePeriod } from './priceTypes';

/**
 * The price widget's series: every period with the level the live classifier
 * gives it, the lines that decided those levels, and the export price where one
 * exists, from PELS's export model or from Homey's export terms. Levels
 * classify the import price only; the export price rides along for display and
 * never feeds a level.
 */
export const buildPriceTimeline = (
  series: CombinedPricePeriod[],
  band: PriceLevelBand,
  exportConfig: ExportPriceConfig,
): Pick<PriceTimeline, 'periods' | 'lines' | 'hasExportPrice'> => {
  const timeline = resolvePriceLevelTimeline(series, band);
  // PELS's own export model, when it is the source. With Homey's export terms
  // the config reads disabled because the Homey series already carries the
  // export price per period, so availability is judged from the periods.
  const periods = applyExportPrices(timeline.periods, exportConfig);
  return {
    periods: periods.map((period) => ({
      startsAt: period.startsAt,
      durationMinutes: period.durationMinutes,
      importPrice: period.totalPrice,
      ...(typeof period.exportPrice === 'number' ? { exportPrice: period.exportPrice } : {}),
      level: period.level,
    })),
    lines: timeline.lines,
    hasExportPrice: periods.some((period) => typeof period.exportPrice === 'number'),
  };
};
