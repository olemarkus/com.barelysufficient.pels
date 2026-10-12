import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { PRICE_SCHEME } from '../utils/settingsKeys';
import { isPriceSchemeSetting } from '../../packages/shared-domain/src/settings/priceScheme';
import type { ExportSchemeChangePlan } from '../../packages/shared-domain/src/settings/exportPriceSchemeChange';
import type {
  PriceSchemeBasis,
  ResolvedPriceScheme,
  SettingsUiHubMarketRead,
} from '../../packages/contracts/src/settingsUiApi';
import type { PriceDataStore } from './priceDataStore';
import { settleExportPriceForSourceChange } from './exportPrice';
import { NORWAY_SETTING_KEYS } from './priceServiceNorway';
import type { PriceScheme } from './priceTypes';

const COUNTRY_CODE = /^[A-Z]{2}$/;

const DEFAULT_RESOLUTION: ResolvedPriceScheme = { scheme: 'norway', basis: { kind: 'default' } };

const NORWAY_CHOSEN: ResolvedPriceScheme = { scheme: 'norway', basis: { kind: 'chosen' } };

/**
 * Only the Norway source's form writes these. It saves the source key only when
 * the owner switches source, so an owner who filled in the Norway settings on a
 * home that was already on Norway never wrote `price_scheme`; any of these
 * written is that owner having set up the Norway source.
 */
const NORWAY_SOURCE_KEYS: readonly string[] = Object.values(NORWAY_SETTING_KEYS);

type PriceSchemeStore = Pick<PriceDataStore, 'readPriceSchemeResolution' | 'writePriceSchemeResolution'>;

const isCountryCode = (value: unknown): value is string => typeof value === 'string' && COUNTRY_CODE.test(value);

const readCachedBasis = (value: unknown): PriceSchemeBasis | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, country } = value as { kind?: unknown; country?: unknown };
  if (kind === 'chosen' || kind === 'default') return { kind };
  return kind === 'hub_location' && isCountryCode(country) ? { kind, country } : null;
};

const readCachedResolution = (value: unknown): ResolvedPriceScheme | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { scheme, basis } = value as { scheme?: unknown; basis?: unknown };
  const cachedBasis = readCachedBasis(basis);
  return isPriceSchemeSetting(scheme) && cachedBasis !== null ? { scheme, basis: cachedBasis } : null;
};

const sameResolution = (a: ResolvedPriceScheme, b: ResolvedPriceScheme): boolean => (
  a.scheme === b.scheme && JSON.stringify(a.basis) === JSON.stringify(b.basis)
);

/**
 * The source PELS assumes for a hub in `country` whose owner never chose one:
 * Norway's own source in Norway, where it adds the grid tariff, taxes and the
 * support scheme itself, and Homey Energy everywhere else. Homey picks a
 * bidding zone from the hub's location by itself, so Homey Energy is the source
 * that already knows where the hub is.
 */
export const assumePriceSchemeForCountry = (country: string): PriceScheme => (
  country === 'NO' ? 'norway' : 'homey'
);

/**
 * What a refresh of the price source did. `held`: PELS would move to
 * `resolution` by itself, but the export price could not be read to settle it
 * for the new source, so the source in force stays and the next refresh tries
 * again.
 */
export type PriceSourceSwitch =
  | { readonly kind: 'none' }
  | { readonly kind: 'switched'; readonly resolution: ResolvedPriceScheme; readonly exportPlan: ExportSchemeChangePlan }
  | { readonly kind: 'held'; readonly resolution: ResolvedPriceScheme };

/** What the settings and the hub's country point to, and whether the owner saved it. */
type SourceReading = { readonly resolution: ResolvedPriceScheme; readonly saved: boolean };

const NO_SWITCH: PriceSourceSwitch = { kind: 'none' };

/**
 * Which price source is in force, and why.
 *
 * A saved `price_scheme` is the owner's choice and always wins, and so is a
 * Norway setting the owner saved without it (see `NORWAY_SOURCE_KEYS`): a hub
 * that reports another country must not move a Norwegian owner's grid tariff
 * and Norgespris off their prices. Otherwise the source is assumed from the
 * hub's country. Until the hub reports it, the source in force stays: the one
 * cached at the last boot, or on a first boot the Norway source every home had
 * before the key existed.
 *
 * A saved source applies at once: whoever saved it settled the export price
 * for it. Any other change of source is one PELS makes by itself, and waits
 * for `refresh`, which settles the export price first. Reads in between keep
 * the source in force, so a recovering settings store or a new hub country can
 * never move the source past the export price.
 *
 * A key that is listed but reads back unusable, a key list the SDK could not
 * answer, or a hub that has not reported its country says nothing new, so the
 * source last in force stays in force rather than flipping on a transient miss.
 * That source is kept in the price cache, so a boot starts from it instead of
 * planning on Norwegian prices until Homey and the settings store answer.
 * Writing the cache is best effort: a failed write is retried on the next
 * refresh, and in the meantime the source held in memory is the one in force.
 */
export class PriceSchemeResolver {
  /** The hub's country, or `null` until Homey answers after this boot. */
  private hubCountry: string | null = null;
  private lastAccepted: ResolvedPriceScheme;
  private lastAcceptedCached = true;

  constructor(
    private readonly settings: SettingsPort,
    private readonly store: PriceSchemeStore,
  ) {
    this.lastAccepted = readCachedResolution(store.readPriceSchemeResolution()) ?? DEFAULT_RESOLUTION;
  }

  resolve(): ResolvedPriceScheme {
    const reading = this.read();
    if (reading === null || this.waitsForRefresh(reading)) return this.lastAccepted;
    return this.accept(reading.resolution);
  }

  /**
   * Take a fresh read of the hub's country, an unanswered one changing nothing,
   * and move to the source PELS now assumes once the export price is settled
   * for it. A failed export write throws and leaves the source in force.
   */
  refresh(market: SettingsUiHubMarketRead): PriceSourceSwitch {
    if (market.state === 'resolved') this.hubCountry = market.country;
    try {
      return this.switchSource();
    } finally {
      this.writeCache();
    }
  }

  private switchSource(): PriceSourceSwitch {
    const reading = this.read();
    if (reading === null) return NO_SWITCH;
    if (!this.waitsForRefresh(reading)) {
      this.accept(reading.resolution);
      return NO_SWITCH;
    }
    const { resolution } = reading;
    const settlement = settleExportPriceForSourceChange(this.settings, this.lastAccepted.scheme, resolution.scheme);
    if (settlement.state === 'unavailable') return { kind: 'held', resolution };
    this.accept(resolution);
    return { kind: 'switched', resolution, exportPlan: settlement.plan };
  }

  /** `null` when the settings or the hub's country cannot say anything new. */
  private read(): SourceReading | null {
    const saved = this.settings.get(PRICE_SCHEME);
    if (isPriceSchemeSetting(saved)) return { resolution: { scheme: saved, basis: { kind: 'chosen' } }, saved: true };
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved' || keys.keys.includes(PRICE_SCHEME)) return null;
    if (NORWAY_SOURCE_KEYS.some((key) => keys.keys.includes(key))) return { resolution: NORWAY_CHOSEN, saved: false };
    const country = this.hubCountry;
    if (country === null) return null;
    return {
      resolution: { scheme: assumePriceSchemeForCountry(country), basis: { kind: 'hub_location', country } },
      saved: false,
    };
  }

  private waitsForRefresh(reading: SourceReading): boolean {
    return !reading.saved && reading.resolution.scheme !== this.lastAccepted.scheme;
  }

  private accept(resolution: ResolvedPriceScheme): ResolvedPriceScheme {
    if (sameResolution(resolution, this.lastAccepted)) return this.lastAccepted;
    this.lastAccepted = resolution;
    this.lastAcceptedCached = false;
    this.writeCache();
    return resolution;
  }

  private writeCache(): void {
    if (this.lastAcceptedCached) return;
    try {
      this.store.writePriceSchemeResolution(this.lastAccepted);
      this.lastAcceptedCached = true;
    } catch {
      // Best effort, see the class comment.
    }
  }
}
