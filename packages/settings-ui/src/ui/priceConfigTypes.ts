import type {
  PriceSetupRead,
  PowerhourSourceUiStatus,
  PriceSchemeSetting,
  PvForecastSourceSetting,
  PvForecastSourceUiStatus,
} from '../../../contracts/src/settingsUiApi.ts';
import type { LiveSummarySignals } from './livePriceSignals.ts';
import type { PriceSetupStatus } from './priceSetupStatus.ts';
import type { ExportPriceSourceSetting } from '../../../shared-domain/src/settings/exportPriceSource.ts';

/**
 * Declared once, in contracts, and read through one shared policy — see
 * `packages/shared-domain/src/settings/priceScheme.ts` for why this union is
 * not written out here.
 */
export type PriceScheme = PriceSchemeSetting;
export type NorwayPriceModel = 'stromstotte' | 'norgespris';

export type StatusTone = 'ok' | 'warn';

export type StatusValue = { text: string; tone: StatusTone };

export type FlowStatus = {
  today: StatusValue;
  tomorrow: StatusValue;
};

export type HomeyStatus = {
  /** Whether Homey Energy has given PELS prices for today or tomorrow. */
  hasPrices: boolean;
  currency: string;
  currencyTone: StatusTone;
  today: StatusValue;
  tomorrow: StatusValue;
  /**
   * Why prices are unavailable, when they are. `null` whenever PELS can work
   * out this home's prices — including the ordinary case of a home whose owner
   * has entered no costs in Homey at all.
   */
  priceSetupIssue: { value: StatusValue; detail: string } | null;
};

/**
 * What the Electricity prices page says about the Power by the Hour source.
 *
 * `source` is the live account from the runtime — whether the app answered and
 * which of its price devices are on offer — while `today`/`tomorrow`/`currency`
 * describe what PELS has actually stored from it, exactly as they do for the
 * other external sources.
 */
export type PowerhourStatus = {
  source: PowerhourSourceUiStatus;
  currency: string;
  currencyTone: StatusTone;
  today: StatusValue;
  tomorrow: StatusValue;
  /**
   * Whether PELS is holding prices from this source at all. A failed read is a
   * no-op, so the stored days outlive an unavailable app and the planner keeps
   * using them — which is why the day rows follow this rather than `source`.
   */
  hasStoredDays: boolean;
};

export type PriceOptDevice = {
  id: string;
  name: string;
  cheapDelta: number;
  expensiveDelta: number;
};

export type GridCompanyOption = {
  name: string;
  organizationNumber: string;
};

export type { PowerhourSourceUiStatus, PvForecastSourceSetting, PvForecastSourceUiStatus };

/**
 * The Electricity prices page's full config state. Lives here (not in
 * `priceConfig.ts`) so `priceConfigSettingsIo.ts` can derive its read/save
 * shapes from it with `Pick<…>` instead of re-declaring them — a hand-written
 * patch type drifts silently, because TypeScript applies no excess-property
 * check to spread properties, so a field dropped here would keep being read
 * from the store and then discarded by the merge with no compile error.
 */
export type PriceConfigState = {
  optimizationEnabled: boolean;
  thresholdPercent: number;
  minDiffOre: number;
  priceScheme: PriceScheme;
  norwayPriceModel: NorwayPriceModel;
  priceArea: string;
  providerSurcharge: number;
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
  flowStatus: FlowStatus | null;
  homeyStatus: HomeyStatus | null;
  powerhourStatus: PowerhourStatus | null;
  /**
   * The Power by the Hour device the owner picked; `null` while they have not.
   * Page state, not view state: the view renders the RESOLVED choice off
   * `powerhourStatus`, and this is here so a save of the price form carries the
   * choice through instead of writing "no device" over it.
   */
  powerhourDeviceId: string | null;
  // `currentPriceLevel` is the raw Homey level read from the power read-model
  // (same field the budget hero consumes). The rest of the "Right now" card's
  // signals — last-fetched time and current-hour export price — are the
  // combined-prices derivations in `liveSummary`
  // (byte-identical to today for a non-prosumer; see livePriceSignals.ts).
  currentPriceLevel: string | null;
  liveSummary: LiveSummarySignals;
  // Export (feed-in) price settings — normalized by `readExportPriceSettings`.
  exportPriceEnabled: boolean;
  exportPriceSource: ExportPriceSourceSetting;
  exportSpotFactor: number;
  exportFixed: number;
  // Solar forecast source: the stored setting plus the runtime provenance
  // (which source actually feeds planning) from the prices payload.
  pvForecastSource: PvForecastSourceSetting;
  pvForecastStatus: PvForecastSourceUiStatus;
  /** The runtime's account of which price settings the owner chose and which PELS assumed. */
  priceSetup: PriceSetupRead;
  /** Whether prices are set up, for the surfaces where price behaviour is turned on. */
  priceSetupStatus: PriceSetupStatus;
};

/** Everything the page's config state takes from the settings store. */
export type PriceConfigSettingsPatch = Pick<
  PriceConfigState,
  | 'optimizationEnabled'
  | 'priceScheme'
  | 'powerhourDeviceId'
  | 'norwayPriceModel'
  | 'priceArea'
  | 'providerSurcharge'
  | 'thresholdPercent'
  | 'minDiffOre'
  | 'countyCode'
  | 'organizationNumber'
  | 'tariffGroup'
  | 'exportPriceEnabled'
  | 'exportPriceSource'
  | 'exportSpotFactor'
  | 'exportFixed'
  | 'pvForecastSource'
>;

/** The subset of the page's config state a save validates and writes. */
export type PriceSettingsSaveInput = Pick<
  PriceConfigState,
  'priceScheme' | 'powerhourDeviceId' | 'providerSurcharge' | 'thresholdPercent' | 'minDiffOre'
>;
