import type { SettingsPort, ApiPort } from '../ports/homeyRuntime';
import { getDateKeyInTimeZone } from '../utils/dateUtils';
import {
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  PRICE_SCHEME,
} from '../utils/settingsKeys';
import {
  addDays,
  fetchGridTariffWithDateFallback,
  findCheapestHoursFromCombined,
  getSpotPriceCacheDecision,
  getSpotPriceDates,
} from './priceServiceUtils';
import { DEFAULT_PERIOD_MINUTES, getFlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';
import { shouldUseGridTariffCache } from './gridTariffUtils';
import { resolveGridTariffFallback } from './staticGridTariffFallback';
import { NETTLEIE_FALLBACK_GENERATED_AT } from './nettleieFallbackData.generated';
import {
  buildHomeyEnergyDateInfo,
  fetchHomeyEnergyResults,
  logHomeyEnergyPayloadStatus,
  shouldUseHomeyEnergyCache,
  storeHomeyEnergyPayloads,
  updateHomeyEnergyCurrency,
} from './homeyEnergyRefresh';
import {
  buildCombinedPricePeriodsFromPayloads,
  purgeStaleFlowPriceSlots,
  storeFlowPriceData as storeFlowPriceDataHelper,
  type FlowSlotChange,
} from './priceServiceFlowHelpers';
import { toHourlyPrices } from './hourlyPriceProjection';
import type { PriceServiceLoggingSinks } from './priceServiceLoggingSinks';
import type { FlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';
import {
  buildCombinedPricePayload,
  combinedRebuildLostActionableEntries,
  getCombinedPayloadLastFetched,
  toCombinedPayloadFingerprint,
} from './priceServiceCombined';
import {
  getCurrentMonthUsageKwh,
  getHourlyUsageEstimateKwh,
  type PowerTrackerReadout,
} from './priceServiceNorgespris';
import {
  buildCombinedHourlyPricesNorway,
  readNorwaySchemeSettings,
  type NorwaySchemeSettings,
} from './priceServiceNorway';
import { applyExportPrices } from './exportPrice';
import { applyBudgetPrices, type BudgetPriceInputs } from './budgetPrice';
import { fetchSpotPricesForDate } from './spotPriceFetch';
import {
  describeCurrentPrice,
  isCurrentPeriodAtLevel,
  resolveCurrentPricePeriodLevel,
  resolveCurrentPriceStartMs,
  type PriceLevelBand,
} from './priceLevelUtils';
import { PriceLevel } from './priceLevels';
import type { CombinedHourlyPrice, CombinedPriceFields, CombinedPricePeriod, PriceScheme } from './priceTypes';
import {
  keepsPersistedPrices, resolveExportConfigForScheme, resolveHomeySeries, syncHomeyPricing,
} from './homeyScheme';
import type { HomeyPriceResolution } from './homeyScheme';
import type { HomeyWebApiGet } from './homeyWebApiPort';
import type { PriceDataStore } from './priceDataStore';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';

const GRID_TARIFF_FAILURE_REASONS: Record<'keepCache' | 'clearStaleFallback' | 'noData', string> = {
  keepCache: 'Keeping cached tariff data (NVE returned empty list)',
  clearStaleFallback: 'Cleared stale fallback (NVE unavailable, no static fallback for current operator)',
  noData: 'NVE unavailable and no static fallback for this operator',
};

export default class PriceService {
  constructor(
    private homey: { settings: SettingsPort; api: ApiPort },
    private readonly sinks: PriceServiceLoggingSinks,
    private getTimeZone: () => string,
    private getHomeyEnergyApi: (() => HomeyEnergyApi | null) | undefined,
    private readonly priceDataStore: PriceDataStore,
    /** The Main home's live power tracker, for the Norgespris usage estimates. */
    private readonly getPowerTracker: () => PowerTrackerReadout,
    /**
     * Reads Homey's own Web API, for the owner's price formula. Homey publishes
     * RAW SPOT per interval and keeps the tariff/tax/VAT expression on a
     * separate route, so without this the Homey scheme plans against wholesale
     * spot — see `lib/price/priceFormula.ts`.
     */
    private readonly homeyWebApiGet: HomeyWebApiGet,
  ) { }

  private onCombinedPricesUpdated?: (reason: string) => void;
  setOnCombinedPricesUpdated(listener: ((reason: string) => void) | undefined): void {
    this.onCombinedPricesUpdated = listener;
  }
  // Forecast-surplus inputs for the planning price, injected by the wiring layer
  // (composed from the PV forecast minus the gross uncontrolled background). Unset
  // for non-prosumers ⇒ budgetPrice is never produced and behaviour is unchanged.
  private budgetPriceInputs?: BudgetPriceInputs;
  setBudgetPriceInputs(inputs: BudgetPriceInputs | undefined): void { this.budgetPriceInputs = inputs; }
  private getSettingValue(key: string): unknown { return this.homey.settings.get(key); }
  private getNumberSetting(key: string, fallback: number): number {
    const value = this.getSettingValue(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
  private emitRealtime(event: string, payload: unknown): void {
    const api = this.homey.api;
    if (!api?.realtime) return;
    api.realtime(event, payload).catch((err) => this.sinks.errorLog?.('Failed to emit realtime event', event, err));
  }

  // Public so the coordinator can gate boot-time work on the active scheme
  // (e.g. the flow-only combined-prices catch-up) without re-deriving the
  // PRICE_SCHEME→scheme mapping. Single source of truth for the early-returns
  // in refreshSpotPrices/getCombinedHourlyPrices.
  getPriceScheme(): PriceScheme {
    const raw = this.getSettingValue(PRICE_SCHEME);
    if (raw === 'flow' || raw === 'homey') return raw;
    return 'norway';
  }

  // Public so app-level callers (e.g. the deferred-objective plan-preview cost
  // estimate) can label a currency without re-deriving the scheme→unit mapping.
  getPriceUnitLabel(): string {
    const scheme = this.getPriceScheme();
    if (scheme === 'norway') return 'øre/kWh';
    if (scheme === 'homey') {
      const currency = this.getSettingValue(HOMEY_PRICES_CURRENCY);
      return typeof currency === 'string' && currency.trim() ? currency : 'price units';
    }
    return 'price units';
  }

  private shouldUseSpotPriceCache(params: {
    forceRefresh: boolean;
    cachedArea: unknown;
    priceArea: string;
    today: Date;
    dates: { todayStr: string; tomorrowStr: string };
  }): boolean {
    const { forceRefresh, cachedArea, priceArea, today, dates } = params;
    if (forceRefresh) return false;
    const existingPrices = this.priceDataStore.readSpotPrices() as Array<{ startsAt?: string }> | null;
    const cacheDecision = getSpotPriceCacheDecision({
      cachedArea,
      priceArea,
      existingPrices,
      dates,
      now: today,
    });
    if (cacheDecision.areaChanged) {
      this.sinks.debugStructured({ event: 'spot_price_area_changed', fromArea: cachedArea, toArea: priceArea });
    }
    if (cacheDecision.useCache) {
      this.sinks.debugStructured({ event: 'spot_price_cache_used', entryCount: existingPrices?.length ?? 0 });
      this.updateCombinedPrices();
      return true;
    }
    if (cacheDecision.shouldFetchTomorrow) {
      this.sinks.debugStructured({ event: 'spot_price_refresh_for_tomorrow' });
    }
    return false;
  }
  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    const scheme = this.getPriceScheme();
    if (scheme === 'flow') {
      this.sinks.debugStructured({ event: 'spot_price_refresh_skipped', reason: 'flow_scheme_active' });
      return;
    }
    if (scheme === 'homey') {
      await this.refreshHomeyEnergyPrices(forceRefresh);
      return;
    }
    const priceArea = this.norwaySchemeSettings.priceArea;
    const cachedArea = this.priceDataStore.readSpotPriceArea();
    const today = new Date();
    const dates = getSpotPriceDates(today);

    if (this.shouldUseSpotPriceCache({
      forceRefresh,
      cachedArea,
      priceArea,
      today,
      dates,
    })) {
      return;
    }

    const todayPrices = await fetchSpotPricesForDate({
      date: today,
      priceArea,
      log: this.sinks.log,
      debugStructured: this.sinks.debugStructured,
      errorLog: this.sinks.errorLog,
    });
    const tomorrowPrices = await fetchSpotPricesForDate({
      date: addDays(today, 1),
      priceArea,
      log: this.sinks.log,
      debugStructured: this.sinks.debugStructured,
      errorLog: this.sinks.errorLog,
    });
    const allPrices = [...todayPrices, ...tomorrowPrices];
    if (allPrices.length === 0) {
      this.sinks.structuredLog?.info({ event: 'spot_prices_no_data' });
      return;
    }
    this.priceDataStore.writeSpotPrices(allPrices);
    this.priceDataStore.writeSpotPriceArea(priceArea);
    this.sinks.structuredLog?.info({ event: 'spot_prices_stored', priceCount: allPrices.length, priceArea });
    this.updateCombinedPrices();
  }
  async refreshGridTariffData(forceRefresh = false): Promise<void> {
    if (this.getPriceScheme() !== 'norway') {
      this.sinks.debugStructured({ event: 'grid_tariff_refresh_skipped', reason: 'non_norway_scheme' });
      return;
    }
    const settings = this.norwaySchemeSettings;
    if (!settings.organizationNumber) {
      this.sinks.structuredLog?.info({ event: 'grid_tariff_skipped', reason: 'no_organization_number' });
      return;
    }
    const requestSettings: { countyCode: string; organizationNumber: string; tariffGroup: string } = {
      countyCode: settings.countyCode,
      organizationNumber: settings.organizationNumber,
      tariffGroup: settings.tariffGroup,
    };

    const todayDate = new Date();
    const timeZone = this.getTimeZone();
    const today = getDateKeyInTimeZone(todayDate, timeZone);
    const existingData = this.priceDataStore.readNettleie() as
      Array<{ dateKey?: string; datoId?: string; source?: unknown }> | null;
    if (!forceRefresh && shouldUseGridTariffCache(existingData, today, this.sinks.debugStructured)) {
      this.updateCombinedPrices();
      return;
    }

    const { data, attempts, logContext } = await fetchGridTariffWithDateFallback({
      settings: requestSettings,
      todayDate,
      timeZone,
      structuredInfo: (payload) => this.sinks.structuredLog?.info(payload),
      errorLog: this.sinks.errorLog,
    });
    if (data) {
      this.storeGridTariffData(data, logContext);
      return;
    }

    // All NVE attempts failed. Keep real cached data if any; otherwise — a new
    // user with nothing cached — seed the static fallback so prices still work
    // until NVE recovers. The fallback is flagged so it never suppresses the
    // next NVE retry (see shouldUseGridTariffCache).
    const outcome = resolveGridTariffFallback({
      existingData,
      organizationNumber: requestSettings.organizationNumber,
      tariffGroup: requestSettings.tariffGroup,
      date: todayDate,
      timeZone,
    });
    if (outcome.kind === 'store') {
      this.storeGridTariffData(
        outcome.entries,
        ` (static fallback — NVE unavailable, no cached tariff; snapshot ${NETTLEIE_FALLBACK_GENERATED_AT})`,
      );
      return;
    }
    if (outcome.kind === 'fallbackCurrent') {
      // Fallback already matches today; recompute combined prices in memory but
      // skip the redundant settings write (flash wear) while NVE stays down.
      this.updateCombinedPrices();
      return;
    }
    if (outcome.kind === 'clearStaleFallback') {
      // The cached data is a stale fallback for an operator we can no longer
      // serve (e.g. the org number changed). Clear it so combined prices don't
      // keep using another operator's tariff.
      this.priceDataStore.writeNettleie([]);
      this.updateCombinedPrices();
    }
    this.sinks.errorLog?.(`Grid tariff: ${GRID_TARIFF_FAILURE_REASONS[outcome.kind]}`, {
      attempts,
      countyCode: requestSettings.countyCode,
      organizationNumber: requestSettings.organizationNumber,
      tariffGroup: requestSettings.tariffGroup,
    });
  }

  private storeGridTariffData(data: Array<Record<string, unknown>>, logContext: string): void {
    this.priceDataStore.writeNettleie(data);
    this.sinks.structuredLog?.info({ event: 'grid_tariff_stored', entryCount: data.length, context: logContext });
    this.updateCombinedPrices();
  }

  updateCombinedPrices(): void {
    const now = new Date();
    const timeZone = this.getTimeZone();
    const combined = this.getCombinedHourlyPrices();
    const payload = buildCombinedPricePayload({
      combined,
      priceScheme: this.getPriceScheme(),
      priceUnit: this.getPriceUnitLabel(),
      thresholdPercent: this.getNumberSetting('price_threshold_percent', 25),
      minDiffOre: this.getNumberSetting('price_min_diff_ore', 0),
      now,
      timeZone,
    });
    const existingPayload = this.priceDataStore.readCombinedRaw();
    // Data safety: never replace still-valid prices with an empty rebuild. A
    // missing/transiently-unreadable/invalid raw flow slot makes the rebuild
    // empty; its fingerprint differs from the populated cache, so the set()
    // below would otherwise clobber good today/tomorrow prices on a transient
    // read (boot catch-up, midnight rotation, every caller). Keep the cache.
    // ...unless the emptiness is a verdict rather than a gap: a home whose
    // price formula is unknown or unevaluable HAS no prices, and keeping the
    // cache would leave every persisted consumer spending against prices built
    // from a formula that no longer applies.
    const homeyPrices = this.getPriceScheme() === 'homey' ? this.resolveHomeyPricePeriods() : null;
    if (keepsPersistedPrices(homeyPrices, this.sinks, () => (
      combinedRebuildLostActionableEntries(existingPayload, payload, now, timeZone)
    ))) {
      this.emitRealtime('prices_updated', existingPayload);
      return;
    }
    if (toCombinedPayloadFingerprint(existingPayload) === toCombinedPayloadFingerprint(payload)) {
      const nextLastFetched = getCombinedPayloadLastFetched(payload);
      const previousLastFetched = getCombinedPayloadLastFetched(existingPayload);
      const shouldUpdateLastFetched = Boolean(nextLastFetched && nextLastFetched !== previousLastFetched);
      this.sinks.debugStructured({ event: 'combined_prices_unchanged', lastFetchedUpdated: shouldUpdateLastFetched });
      if (shouldUpdateLastFetched) this.priceDataStore.writeCombined(payload);
      this.emitRealtime('prices_updated', payload);
      return;
    }
    this.priceDataStore.writeCombined(payload);
    this.emitRealtime('prices_updated', payload);
    this.onCombinedPricesUpdated?.('changed');
  }

  /**
   * Rebuilt on every call, deliberately. Memoizing this is DECIDED AGAINST as
   * specified: an invalidation-based cache is unsafe while `price_area`,
   * `nettleie_fylke`, `nettleie_orgnr` and `nettleie_tariffgruppe` are written by
   * the settings UI (`packages/settings-ui/src/ui/priceConfig.ts`) but have no
   * entry in the `lib/utils/settingsHandlers.ts` routing table, so nothing calls
   * `updateCombinedPrices()` when they change. The live rebuild is what keeps a
   * price-area or grid-operator change visible; a cache invalidated at that
   * funnel would serve stale prices. Precondition for revisiting: route those
   * four keys through `refreshPriceDerivedState` first, which is a behaviour
   * change of its own since it makes them trigger a plan rebuild. The cost of
   * leaving it is about two builds (~50 ms) per rebuild.
   */
  getCombinedHourlyPrices(): CombinedHourlyPrice[] {
    // Export (feed-in) pricing is kept separate from the import scheme and applied
    // scheme-independently to the import series — see `applyExportPrices`. The
    // planning price (budgetPrice) is then derived on top from the injected forecast
    // surplus — see `applyBudgetPrices` (no-op for non-prosumers).
    return this.withExportAndPlanningPrices(this.buildImportHourlyPrices());
  }

  /**
   * The same prices as {@link buildImportPricePeriods}, as whole hours.
   *
   * Everything but the price level reasons in hours — the capacity tariff is an
   * hourly peak, the daily budget fills hourly buckets, a smart task claims
   * hours — so sub-hourly periods are projected here, in the producer, rather
   * than each consumer guessing how long a period lasts. The Norwegian series
   * is hourly at the source and carries the whole cost stack (spot price, grid
   * tariff, taxes, VAT) that the money surfaces read, so it is served as it is
   * built rather than round-tripped through a projection that would keep only
   * the price.
   */
  private buildImportHourlyPrices(): CombinedHourlyPrice[] {
    const scheme = this.getPriceScheme();
    if (scheme === 'norway') return this.getCombinedHourlyPricesNorway();
    return toHourlyPrices(this.buildImportPricePeriods(), this.getTimeZone());
  }

  /**
   * The price series at the periods the source published, for the one consumer
   * that asks what the price is *right now* rather than this hour: the price
   * level (and the temperature shift, the `price_level` trigger and the
   * insights capability that follow it).
   *
   * Export and planning prices are layered on exactly as they are for the hourly
   * series, so a prosumer's level still classifies the planning price.
   */
  getCombinedPricePeriods(): CombinedPricePeriod[] {
    return this.withExportAndPlanningPrices(this.buildImportPricePeriods());
  }

  /**
   * The two decorations every import series carries, in order: the feed-in
   * price, then the planning price derived on top of it. Shared by both shapes
   * — periods and whole hours — so neither can drift from the other about what
   * the owner is paid or what the planner optimises against.
   */
  private withExportAndPlanningPrices<T extends CombinedPriceFields>(series: T[]): T[] {
    const exportConfig = resolveExportConfigForScheme(
      this.homey.settings,
      (key) => this.getSettingValue(key),
      (key, fallback) => this.getNumberSetting(key, fallback),
    );
    return applyBudgetPrices(applyExportPrices(series, exportConfig), this.budgetPriceInputs, this.getTimeZone());
  }

  private buildImportPricePeriods(): CombinedPricePeriod[] {
    const scheme = this.getPriceScheme();
    if (scheme === 'flow') {
      return this.getPricePeriodsFromPayloads(FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, 'Flow prices');
    }
    if (scheme === 'homey') return this.resolveHomeyPricePeriods().periods;
    // Norwegian spot prices are hourly, and each entry carries the whole cost
    // stack, so the hour IS the period here.
    return this.getCombinedHourlyPricesNorway()
      .map((entry) => ({ ...entry, durationMinutes: DEFAULT_PERIOD_MINUTES }));
  }

  /**
   * The Homey series, priced through the owner's formula.
   *
   * What Homey stores per period is wholesale spot; the owner's grid tariff,
   * taxes and VAT live in a separate expression Homey applies only inside its
   * own features, so resolving it here is what makes these the prices the owner
   * actually pays (`lib/price/priceFormula.ts`). One classifier answers both
   * "what are the prices" and "can this home be priced at all", so the two can
   * never disagree.
   */
  resolveHomeyPricePeriods(): HomeyPriceResolution {
    const raw = this.getPricePeriodsFromPayloads(HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW, 'Homey prices');
    return resolveHomeySeries(raw, this.homey.settings);
  }

  private getCombinedHourlyPricesNorway(): CombinedHourlyPrice[] {
    const settings = this.norwaySchemeSettings;
    const { priceArea, norwayPriceModel } = settings;
    const timeZone = this.getTimeZone();
    const currentMonthKey = getDateKeyInTimeZone(new Date(), timeZone).slice(0, 7);
    return buildCombinedHourlyPricesNorway({
      spotPrices: this.priceDataStore.readSpotPrices(),
      gridTariffData: this.priceDataStore.readNettleie(),
      providerSurchargeIncVat: this.getNumberSetting('provider_surcharge', 0),
      priceArea,
      countyCode: settings.countyCode,
      tariffGroup: settings.tariffGroup,
      norwayPriceModel,
      monthUsageKwh: norwayPriceModel === 'norgespris'
        ? getCurrentMonthUsageKwh(this.getPowerTracker(), this.getTimeZone())
        : 0,
      hourlyUsageEstimateKwh: norwayPriceModel === 'norgespris' ? getHourlyUsageEstimateKwh(this.getPowerTracker()) : 0,
      now: new Date(),
      currentMonthKey,
      timeZone,
    });
  }

  private rotateFlowPriceSlots(params: {
    now: Date;
    timeZone: string;
    todaySettingKey: string;
    tomorrowSettingKey: string;
    label: 'Flow prices' | 'Homey prices';
  }): { todayPayload: FlowPricePayload | null; tomorrowPayload: FlowPricePayload | null } {
    const { now, timeZone, todaySettingKey, tomorrowSettingKey, label } = params;
    const purge = purgeStaleFlowPriceSlots({
      now,
      timeZone,
      todayPayload: getFlowPricePayload(this.priceDataStore.readFlowPayload(todaySettingKey)),
      tomorrowPayload: getFlowPricePayload(this.priceDataStore.readFlowPayload(tomorrowSettingKey)),
    });
    purge.changes.forEach((change: FlowSlotChange) => {
      this.sinks.debugStructured({
        event: 'flow_price_slot_rotated', priceSource: label,
        slot: change.slot, action: change.action, from: change.from,
      });
    });
    if (purge.changes.some((c) => c.slot === 'today' || c.action === 'promoted_to_today')) {
      this.priceDataStore.writeFlowPayload(todaySettingKey, purge.todayPayload);
    }
    if (purge.changes.some((c) => c.slot === 'tomorrow')) {
      this.priceDataStore.writeFlowPayload(tomorrowSettingKey, purge.tomorrowPayload);
    }
    return { todayPayload: purge.todayPayload, tomorrowPayload: purge.tomorrowPayload };
  }

  /**
   * The stored day payloads as the periods their source published, rotated for
   * the local date first. `buildImportPricePeriods` serves the price level from
   * these; `buildImportHourlyPrices` projects them onto hours for everything
   * else.
   */
  private getPricePeriodsFromPayloads(
    todaySettingKey: string,
    tomorrowSettingKey: string,
    label: 'Flow prices' | 'Homey prices',
  ): CombinedPricePeriod[] {
    const now = new Date();
    const timeZone = this.getTimeZone();
    const { todayPayload, tomorrowPayload } = this.rotateFlowPriceSlots({
      now,
      timeZone,
      todaySettingKey,
      tomorrowSettingKey,
      label,
    });
    return buildCombinedPricePeriodsFromPayloads({
      now,
      timeZone,
      todayPayload,
      tomorrowPayload,
      debugStructured: this.sinks.debugStructured,
      label,
    });
  }

  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    return storeFlowPriceDataHelper({
      kind,
      raw,
      timeZone: this.getTimeZone(),
      debugStructured: this.sinks.debugStructured,
      writeFlowPayload: (key, payload) => this.priceDataStore.writeFlowPayload(key, payload),
      updateCombinedPrices: () => this.updateCombinedPrices(),
    });
  }

  findCheapestHours(count: number): string[] {
    return findCheapestHoursFromCombined(this.getCombinedHourlyPrices(), count, Date.now());
  }

  isCurrentHourCheap(): boolean {
    return isCurrentPeriodAtLevel(this.getCombinedPricePeriods(), this.priceLevelBand, 'cheap');
  }

  isCurrentHourExpensive(): boolean {
    return isCurrentPeriodAtLevel(this.getCombinedPricePeriods(), this.priceLevelBand, 'expensive');
  }

  private get priceLevelBand(): PriceLevelBand {
    return {
      thresholdPercent: this.getNumberSetting('price_threshold_percent', 25),
      minDiff: this.getNumberSetting('price_min_diff_ore', 0),
    };
  }

  /**
   * The RESOLVED price level in force, from a SINGLE series build — use this
   * rather than calling `isCurrentHourCheap()` and `isCurrentHourExpensive()`
   * back to back, which builds the series twice for one question. See
   * `resolveCurrentPricePeriodLevel` for what that build costs and why it has
   * no cache.
   */
  getCurrentHourPriceLevel(): PriceLevel {
    return resolveCurrentPricePeriodLevel(this.getCombinedPricePeriods(), this.priceLevelBand);
  }

  getCurrentHourPriceInfo(): string {
    return describeCurrentPrice(
      this.getCombinedPricePeriods(),
      this.getPriceScheme(),
      this.getPriceUnitLabel(),
    );
  }

  private get norwaySchemeSettings(): NorwaySchemeSettings {
    return readNorwaySchemeSettings({ getRaw: (key) => this.getSettingValue(key) });
  }

  getCurrentHourStartMs(): number {
    return resolveCurrentPriceStartMs(this.getCombinedPricePeriods(), this.getTimeZone());
  }

  private async refreshHomeyEnergyPrices(forceRefresh: boolean): Promise<void> {
    if (this.getPriceScheme() !== 'homey') {
      this.sinks.debugStructured({ event: 'homey_energy_refresh_skipped', reason: 'non_homey_scheme' });
      return;
    }
    const energyApi = this.getHomeyEnergyApi?.();
    if (!energyApi) {
      this.sinks.structuredLog?.info({ event: 'homey_energy_api_unavailable' });
      return;
    }
    // Before the cache check, because the cached path still rebuilds the
    // combined series: a formula the owner changed since the last refresh has
    // to be mirrored even on a day whose raw prices are already stored.
    if (await syncHomeyPricing(this.homeyWebApiGet, this.homey.settings, this.sinks)) {
      this.updateCombinedPrices();
    }
    const info = buildHomeyEnergyDateInfo(this.getTimeZone());
    if (shouldUseHomeyEnergyCache({
      info,
      forceRefresh,
      getSettingValue: (key) => this.getSettingValue(key),
      debugStructured: this.sinks.debugStructured,
      updateCombinedPrices: () => this.updateCombinedPrices(),
    })) {
      return;
    }

    const results = await fetchHomeyEnergyResults({
      energyApi,
      info,
    });
    if (!results) return;

    logHomeyEnergyPayloadStatus({
      info,
      results,
      debugStructured: this.sinks.debugStructured,
    });

    await updateHomeyEnergyCurrency({
      energyApi,
      results,
      writeHomeyPricesCurrency: (unit) => this.priceDataStore.writeHomeyPricesCurrency(unit),
    });
    const stored = storeHomeyEnergyPayloads({
      results,
      writeFlowPayload: (key, payload) => this.priceDataStore.writeFlowPayload(key, payload),
    });
    if (stored === 0) {
      this.sinks.structuredLog?.info({ event: 'homey_prices_no_data' });
      return;
    }
    this.sinks.structuredLog?.info({ event: 'homey_prices_stored', dayCount: stored });
    this.updateCombinedPrices();
  }
}
