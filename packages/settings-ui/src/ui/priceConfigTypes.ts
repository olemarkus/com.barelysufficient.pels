import type { PriceScheme, NorwayPriceModel } from './priceSettingsPersistence.ts';
import type {
  PvForecastSourceSetting,
  PvForecastSourceUiStatus,
} from '../../../contracts/src/settingsUiApi.ts';
import type { LiveSummarySignals } from './livePriceSignals.ts';

export type StatusTone = 'ok' | 'warn';

export type StatusValue = { text: string; tone: StatusTone };

export type FlowStatus = {
  today: StatusValue;
  tomorrow: StatusValue;
};

export type HomeyStatus = {
  currency: string;
  currencyTone: StatusTone;
  today: StatusValue;
  tomorrow: StatusValue;
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

export type { PriceScheme, NorwayPriceModel };
export type { PvForecastSourceSetting, PvForecastSourceUiStatus };

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
  // `currentPriceLevel` is the raw Homey level read from the power read-model
  // (same field the budget hero consumes). The rest of the "Right now" card's
  // signals — last-fetched time, current-hour export price, and the `using your
  // solar` reason line — are the combined-prices derivations in `liveSummary`
  // (byte-identical to today for a non-prosumer; see livePriceSignals.ts).
  currentPriceLevel: string | null;
  liveSummary: LiveSummarySignals;
  // Export (feed-in) price settings — normalized by `readExportPriceSettings`.
  exportPriceEnabled: boolean;
  exportSpotFactor: number;
  exportFixed: number;
  // Solar forecast source: the stored setting plus the runtime provenance
  // (which source actually feeds planning) from the prices payload.
  pvForecastSource: PvForecastSourceSetting;
  pvForecastStatus: PvForecastSourceUiStatus;
};

/** Everything the page's config state takes from the settings store. */
export type PriceConfigSettingsPatch = Pick<
  PriceConfigState,
  | 'optimizationEnabled'
  | 'priceScheme'
  | 'norwayPriceModel'
  | 'priceArea'
  | 'providerSurcharge'
  | 'thresholdPercent'
  | 'minDiffOre'
  | 'countyCode'
  | 'organizationNumber'
  | 'tariffGroup'
  | 'exportPriceEnabled'
  | 'exportSpotFactor'
  | 'exportFixed'
  | 'pvForecastSource'
>;

/** The subset of the page's config state a save validates and writes. */
export type PriceSettingsSaveInput = Pick<
  PriceConfigState,
  'priceScheme' | 'norwayPriceModel' | 'priceArea' | 'providerSurcharge' | 'thresholdPercent' | 'minDiffOre'
>;
