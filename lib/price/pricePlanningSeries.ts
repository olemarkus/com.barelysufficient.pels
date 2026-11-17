import {
  applyBudgetPrices, readBudgetPriceInputs, resolveBudgetPricedHours, type BudgetPriceInputs,
} from './budgetPrice';
import { applyExportPrices, type ExportPriceConfig } from './exportPrice';
import type { SettingsPort } from '../ports/homeyRuntime';
import {
  FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, HOMEY_EXPORT_PRICE_TERMS, HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW,
  HOMEY_PRICE_FORMULA, POWERHOUR_PRICES_TODAY, POWERHOUR_PRICES_TOMORROW,
} from '../utils/settingsKeys';
import { getDateKeyInTimeZone } from '../../packages/shared-domain/src/utils/dateUtils';
import { usesHomeyExportTerms } from './homeyScheme';
import { usesPowerhourExportPrices } from './powerhourScheme';
import type { PriceDataStore } from './priceDataStore';
import {
  getCurrentMonthUsageKwh, getHourlyUsageEstimateKwh, type PowerTrackerReadout,
} from './priceServiceNorgespris';
import { NORWAY_SETTING_KEYS } from './priceServiceNorway';
import type { CombinedPriceFields, CombinedPricePeriod, PriceScheme } from './priceTypes';

/** Export decisions use feed-in value alone, before solar planning adjustments. */
export const isExportCostlyAt = (
  series: CombinedPricePeriod[],
  exportConfig: ExportPriceConfig,
  nowMs: number,
): boolean => applyExportPrices(series, exportConfig).some((period) => {
  const start = Date.parse(period.startsAt);
  return start <= nowMs && nowMs < start + period.durationMinutes * 60_000
    && typeof period.exportPrice === 'number' && Number.isFinite(period.exportPrice) && period.exportPrice < 0;
});

/** Both native and hourly planning series derive solar value after export pricing. */
export const applyPlanningPriceDecorations = <T extends CombinedPriceFields>(
  series: T[],
  exportConfig: ExportPriceConfig,
  budgetInputs: BudgetPriceInputs | undefined,
  timeZone: string,
): T[] => applyBudgetPrices(
  applyExportPrices(series, exportConfig),
  budgetInputs,
  timeZone,
);

/**
 * The planning price periods, built once and handed out until an input they
 * were built from changes.
 *
 * Smart tasks ask for a price horizon per task on every plan rebuild, and each
 * answer is cut from the same series. Prices move about twice a day, so
 * building the series per request spent most of its work on an identical
 * result.
 *
 * Nothing here is told that an input changed. Every request reads each input
 * the build reads and compares it with what the held series was built from,
 * so the settings the series reads without a settings handler
 * (`NORWAY_SETTING_KEYS`) still take effect at once. An input added to the
 * build must be added to these reads, or the series outlives it.
 *
 * The price caches compare by identity. `PriceCacheStore` holds each parsed
 * row in memory, replaces it on a write that changes it, and is the only
 * writer of its rows, so the same object back means the same stored prices.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The series as its readers get it: shared between them, so none may change it. */
export type PlanningPricePeriods = ReadonlyArray<Readonly<CombinedPricePeriod>>;

type ImportSeriesStore = Pick<
  PriceDataStore, 'readFlowPayload' | 'readSpotPrices' | 'readSpotPriceArea' | 'readNettleie'
>;

/** A mirrored settings object by its content: the SDK promises a value, not the same object twice. */
const settingContent = (settings: SettingsPort, key: string): string | undefined => (
  JSON.stringify(settings.get(key))
);

const readNorwayInputs = (
  settings: SettingsPort,
  store: ImportSeriesStore,
  powerTracker: PowerTrackerReadout,
  timeZone: string,
  now: Date,
): unknown[] => {
  const inputs: unknown[] = [
    store.readSpotPrices(),
    store.readSpotPriceArea(),
    store.readNettleie(),
    ...Object.values(NORWAY_SETTING_KEYS).map((key) => settings.get(key)),
  ];
  if (settings.get(NORWAY_SETTING_KEYS.pricingModel) !== 'norgespris') return inputs;
  // Norgespris prices the hours ahead from what the home has used this month
  // and draws now, and stops projecting the cap onto an hour once it is past.
  return [
    ...inputs,
    getCurrentMonthUsageKwh(powerTracker, timeZone),
    getHourlyUsageEstimateKwh(powerTracker),
    Math.floor(now.getTime() / HOUR_MS),
  ];
};

/**
 * Everything the import series of `scheme` is built from, beyond the scheme,
 * the time zone and the local date. One entry per input, compared with
 * `Object.is`.
 */
const readImportSeriesInputs = (
  scheme: PriceScheme,
  settings: SettingsPort,
  store: ImportSeriesStore,
  powerTracker: PowerTrackerReadout,
  timeZone: string,
  now: Date,
): unknown[] => {
  if (scheme === 'flow') {
    return [store.readFlowPayload(FLOW_PRICES_TODAY), store.readFlowPayload(FLOW_PRICES_TOMORROW)];
  }
  if (scheme === 'homey') {
    return [
      store.readFlowPayload(HOMEY_PRICES_TODAY),
      store.readFlowPayload(HOMEY_PRICES_TOMORROW),
      settingContent(settings, HOMEY_PRICE_FORMULA),
      usesHomeyExportTerms(settings, scheme),
      settingContent(settings, HOMEY_EXPORT_PRICE_TERMS),
    ];
  }
  if (scheme === 'powerhour') {
    return [
      store.readFlowPayload(POWERHOUR_PRICES_TODAY),
      store.readFlowPayload(POWERHOUR_PRICES_TOMORROW),
      usesPowerhourExportPrices(settings, scheme),
    ];
  }
  return readNorwayInputs(settings, store, powerTracker, timeZone, now);
};

const sameInputs = (held: readonly unknown[], read: readonly unknown[]): boolean => (
  held.length === read.length && held.every((input, index) => Object.is(input, read[index]))
);

type HeldSeries = {
  periods: PlanningPricePeriods;
  seriesInputs: readonly unknown[];
  /** The hours whose forecast surplus the planning price of `periods` read. */
  budgetHoursMs: readonly number[];
  budgetInputs: readonly unknown[];
};

export class ReusedPlanningSeries {
  private held: HeldSeries | null = null;

  constructor(
    private readonly settings: SettingsPort,
    private readonly store: ImportSeriesStore,
    private readonly getPowerTracker: () => PowerTrackerReadout,
    private readonly getTimeZone: () => string,
  ) {}

  /**
   * The held series when every input reads as it did when the series was
   * built, else a fresh `build`. The inputs are read before the build: a local
   * date read after a build that crossed midnight would mark yesterday's
   * series as today's.
   *
   * An empty series is never held. A home without prices is waiting for a
   * fetch, a legacy import or a readable setting, and the build's own reads
   * are what notice each of those arriving.
   */
  read(
    scheme: PriceScheme,
    exportConfig: ExportPriceConfig,
    budgetInputs: BudgetPriceInputs | undefined,
    build: () => CombinedPricePeriod[],
  ): PlanningPricePeriods {
    const timeZone = this.getTimeZone();
    const now = new Date();
    const seriesInputs = [
      scheme, timeZone, getDateKeyInTimeZone(now, timeZone),
      exportConfig.enabled, exportConfig.spotFactorPercent, exportConfig.fixedInclVat,
      ...readImportSeriesInputs(scheme, this.settings, this.store, this.getPowerTracker(), timeZone, now),
    ];
    const { held } = this;
    if (held !== null
      && sameInputs(held.seriesInputs, seriesInputs)
      && sameInputs(held.budgetInputs, readBudgetPriceInputs(held.budgetHoursMs, budgetInputs))) {
      return held.periods;
    }
    const periods = build();
    const budgetHoursMs = resolveBudgetPricedHours(periods, timeZone);
    this.held = periods.length === 0 ? null : {
      periods,
      seriesInputs,
      budgetHoursMs,
      budgetInputs: readBudgetPriceInputs(budgetHoursMs, budgetInputs),
    };
    return periods;
  }
}
