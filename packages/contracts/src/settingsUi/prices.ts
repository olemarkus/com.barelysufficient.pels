import type { PriceOptimizationSetupRead } from '../priceOptimizationSettings.js';
import type { PriceTimelineLines, PriceTimelineRead } from '../priceTimeline.js';

/**
 * The `pv_forecast_source` setting values — the ONE declaration of this union.
 * Runtime code re-exports it type-only (`lib/solar/pvForecastSource.ts`), and
 * the shared junk classifier lives in
 * `packages/shared-domain/src/settings/pvForecastSource.ts` so the runtime
 * and the settings UI can never disagree on what a junk value means.
 */
export type PvForecastSourceSetting = 'auto' | 'homey_energy' | 'learned';

/**
 * The `price_scheme` setting values — the ONE declaration of this union.
 * `lib/price/priceTypes.ts` re-exports it type-only for the runtime, the
 * settings UI re-exports it for the selector, and the shared junk classifier
 * lives in `packages/shared-domain/src/settings/priceScheme.ts` so neither
 * side can invent its own reading of the same bytes.
 *
 * - `norway` — Norwegian spot plus the whole cost stack PELS itemises itself.
 * - `flow` — hourly totals the owner feeds in through a Flow action.
 * - `homey` — Homey Energy's day-ahead prices, through the owner's formula.
 * - `powerhour` — the prices the Power by the Hour app already holds, read
 *   directly from it over Homey's app-to-app API.
 */
export type PriceSchemeSetting = 'norway' | 'flow' | 'homey' | 'powerhour';

/**
 * The provenance the runtime selector reports: `activeSource` is what actually
 * feeds planning right now, and the two availability flags say whether each
 * producer currently has a usable forecast — Homey Energy's route (firmware
 * 13.4.0+ with a solar device) and the learned model's fit — so the section can
 * state honestly when the selected source is still running without one. All
 * come from the runtime selector, never recomputed UI-side.
 */
export type PvForecastSourceSelectedStatus = {
  kind: 'selected';
  activeSource: Exclude<PvForecastSourceSetting, 'auto'>;
  homeyForecastAvailable: boolean;
  learnedForecastAvailable: boolean;
};

/**
 * Live provenance of the PV-forecast source selection, for the Electricity
 * prices view's Solar forecast section (`PvForecastSourceSetting` itself is
 * declared once further up).
 *
 * Absence is a NAMED member, not a nullable value: `unknown` is the honest
 * answer while the runtime has not wired the forecast selector yet (the boot
 * window), and equally when the payload crossing the WebView bridge does not
 * carry a well-formed status. A selection, once made, always names a source —
 * `auto` resolves to one of the two producers, so `activeSource` is never
 * absent inside the `selected` arm.
 */
export type PvForecastSourceUiStatus =
  | PvForecastSourceSelectedStatus
  | { kind: 'unknown' };

/**
 * Whether PELS can work out this home's prices from Homey's own price setup.
 *
 * Only the Homey Energy price source has one. `applied` and `none` are both
 * working states — a home with no formula is priced by the raw value Homey
 * publishes — while the other two mean the home has NO prices, which the owner
 * otherwise sees as an unexplained blank.
 */
export type HomeyPriceFormulaUiStatus =
  | { kind: 'applied' }
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'unsupported'; expression: string }
  /**
   * The formula is arithmetic PELS can read, and it produced no usable price
   * for any hour published — `(price - 1) ^ 0.5` while every price is below 1,
   * say. Distinct from `unsupported`, because there is nothing wrong with the
   * expression itself and the owner needs telling something different.
   */
  | { kind: 'prices_nothing'; expression: string };

/**
 * One price-publishing device in the Power by the Hour app, as the owner has
 * to choose between them: PELS prices the home from exactly one, and a home
 * can have several (an hourly zone and a quarter-hourly one, electricity and
 * gas).
 */
export type PowerhourDeviceUiOption = {
  deviceId: string;
  deviceName: string;
  /** `60` on the hourly driver, `15` on the quarter-hourly one. */
  priceIntervalMinutes: number;
  /** ENTSO-E bidding zone code, as Power by the Hour reports it; `''` when it has none. */
  biddingZone: string;
};

/**
 * What to tell the owner about the Power by the Hour price source.
 *
 * Every arm but `reading` means the home has NO prices from this source, and
 * each names a different thing for the owner to do — which is why they are not
 * one nullable error string. `unknown` is the honest answer before the price
 * seam is wired (the boot window) and on every other price source.
 */
export type PowerhourSourceUiStatus =
  | { kind: 'unknown' }
  /** The app is not installed, or is installed but not running. */
  | { kind: 'app_unavailable' }
  /**
   * Homey refused the app-to-app handle. Either this Homey is a Cloud Homey
   * (where app-to-app calls do not exist) or the permission was withheld —
   * neither is something a retry fixes.
   */
  | { kind: 'not_permitted' }
  /** The app answered, but the owner has paired no price device in it. */
  | { kind: 'no_devices' }
  /** The app answered, but the device the owner picked is no longer among them. */
  | { kind: 'device_missing'; deviceId: string; devices: PowerhourDeviceUiOption[] }
  /** Prices are being read from `selected`. */
  | { kind: 'reading'; selected: PowerhourDeviceUiOption; devices: PowerhourDeviceUiOption[] };

/**
 * The day payloads and currencies the payload-fed price sources (Flow, Homey
 * Energy, Power by the Hour) have stored, as the settings UI reports on them.
 * Each is `null` while nothing is stored.
 */
export type SettingsUiPriceSourcePayloads = {
  flowToday: unknown | null;
  flowTomorrow: unknown | null;
  homeyCurrency: string | null;
  homeyToday: unknown | null;
  homeyTomorrow: unknown | null;
  powerhourCurrency: string | null;
  powerhourToday: unknown | null;
  powerhourTomorrow: unknown | null;
};

/**
 * Why the price source in force is the one it is.
 *
 * - `chosen` — the owner saved it.
 * - `hub_location` — never saved, so PELS assumed it from the hub's country:
 *   Norway's own source in Norway, Homey Energy everywhere else.
 * - `default` — never saved, and the hub's country is not known yet, so PELS
 *   runs on the Norway source it has always defaulted to.
 */
export type PriceSchemeBasis =
  | { readonly kind: 'chosen' }
  | { readonly kind: 'hub_location'; readonly country: string }
  | { readonly kind: 'default' };

export type ResolvedPriceScheme = {
  readonly scheme: PriceSchemeSetting;
  readonly basis: PriceSchemeBasis;
};

/** A setting's value as PELS uses it, and whether the owner saved it or PELS assumed it. */
export type PriceSettingChoice<T> = {
  readonly value: T;
  readonly chosen: boolean;
};

export type NorwayPriceModelSetting = 'stromstotte' | 'norgespris';

/**
 * The Norway source's settings as PELS uses them. With no grid company PELS
 * leaves the grid tariff out of every price, which is a state of its own, not a
 * missing value.
 */
export type NorwayPriceSetup = {
  readonly county: PriceSettingChoice<string>;
  readonly gridCompany:
    | { readonly kind: 'chosen'; readonly organizationNumber: string }
    | { readonly kind: 'none' };
  readonly tariffGroup: PriceSettingChoice<string>;
  readonly pricingModel: PriceSettingChoice<NorwayPriceModelSetting>;
  readonly priceArea: PriceSettingChoice<string>;
};

/** Which prices PELS is running on, and which of them the owner actually chose. */
export type PriceSetup = {
  readonly source: ResolvedPriceScheme;
  readonly norway: NorwayPriceSetup;
};

export type PriceSetupRead =
  | { readonly state: 'resolved'; readonly setup: PriceSetup }
  | { readonly state: 'unavailable' };

/**
 * The Norway price settings PELS found for the hub's location, for the owner to
 * confirm. Each part is looked up only while the owner has not chosen it: the
 * grid company whose area the hub is in, with the county it was found in, and
 * the price area Homey Energy uses for the hub. `none` is a part with nothing
 * to offer: chosen already, a hub not known to be in Norway, a location no grid
 * company covers, or a lookup that failed. PELS writes none of it until the
 * owner confirms.
 */
export type NorwayPriceSetupSuggestion = {
  readonly gridCompany:
    | {
      readonly kind: 'found';
      readonly organizationNumber: string;
      readonly name: string;
      readonly countyCode: string;
    }
    | { readonly kind: 'none' };
  readonly priceArea:
    | { readonly kind: 'from_homey_energy'; readonly area: string }
    | { readonly kind: 'none' };
};

/**
 * What PELS can suggest for the price setup: the Norway settings above, and,
 * while Homey Energy is the source, whether Power by the Hour is installed
 * with a price device PELS could read prices from instead (`no_price_device`:
 * it is running and has none).
 */
export type PriceSetupSuggestion = NorwayPriceSetupSuggestion & {
  readonly powerhour:
    | { readonly kind: 'has_price_device' }
    | { readonly kind: 'no_price_device' }
    | { readonly kind: 'none' };
};

/**
 * One setting change that makes the cheapest quarter of the known prices count
 * as cheap, offered only while no price is cheap or expensive at the owner's
 * band: `cheapUpTo` is the highest of those prices. `lower_threshold` is a
 * lower percent, for when the percent is what keeps them normal;
 * `lower_min_difference` is a lower minimum difference (in the price source's
 * unit), for when the minimum difference is. `none` when some period already
 * misses the band, when the change would also mark a price expensive, when the
 * prices are too flat for a threshold of 5 % or more to separate them, or when
 * both settings keep them normal, so no single change would.
 */
export type PriceThresholdSuggestion =
  | { readonly kind: 'lower_threshold'; readonly percent: number; readonly cheapUpTo: number }
  | { readonly kind: 'lower_min_difference'; readonly minDifference: number; readonly cheapUpTo: number }
  | { readonly kind: 'none' };

/**
 * Where the owner's band puts the cheap and expensive lines over the known
 * prices, as the live classifier draws them, and what those prices reach.
 * Prices are in the source's own unit (`priceUnit`).
 */
export type PriceLevelSummary = {
  readonly lines: PriceTimelineLines;
  readonly lowest: number;
  readonly highest: number;
  readonly hasCheap: boolean;
  readonly hasExpensive: boolean;
  readonly priceUnit: string;
  readonly suggestion: PriceThresholdSuggestion;
};

export type PriceLevelSummaryRead =
  | ({ readonly state: 'ready' } & PriceLevelSummary)
  | { readonly state: 'unavailable' };

export type SettingsUiTaskPricePeriod = {
  startsAtMs: number;
  endsAtMs: number;
  price: number;
  planningPrice: number;
  isCheap: boolean;
  isExpensive: boolean;
};

export type SettingsUiPricesPayload = SettingsUiPriceSourcePayloads & {
  combinedPrices: unknown | null;
  /** Native price periods for the current import and export prices. */
  priceTimeline: PriceTimelineRead;
  taskPricePeriods: SettingsUiTaskPricePeriod[];
  priceArea: string | null;
  /** `{ kind: 'unknown' }` during the boot window before the forecast selector is wired. */
  pvForecastSource: PvForecastSourceUiStatus;
  /** `{ kind: 'unknown' }` before the price seam is wired, or off the Homey source. */
  homeyPriceFormula: HomeyPriceFormulaUiStatus;
  /** `{ kind: 'unknown' }` before the price seam is wired, or off the Power by the Hour source. */
  powerhourSource: PowerhourSourceUiStatus;
  /** Price-domain-classified setup facts; never a raw settings blob. */
  priceOptimizationSetup: PriceOptimizationSetupRead;
  /** The price source and Norway settings in force, each marked chosen or assumed. */
  priceSetup: PriceSetupRead;
  /** The cheap and expensive lines over the known prices, for the threshold form. */
  priceLevelSummary: PriceLevelSummaryRead;
};
