import type { Logger as PinoLogger } from '../logging/logger';
import type { HomeyWebApiGet } from './homeyPriceFormula';
import type {
  NorwayPriceSetup,
  PriceSetupSuggestion,
  SettingsUiHubMarketRead,
} from '../../packages/contracts/src/settingsUiApi';

/**
 * The hub's location as the wiring reads it from Homey. Declared here rather
 * than imported because its owner is `lib/solar`, which the price module may
 * not import (`no-price-to-peer`); the wiring's reader satisfies it as is.
 */
export type HubLocationRead =
  | { kind: 'resolved'; coordinates: { latitude: number; longitude: number } }
  | { kind: 'unavailable' };

/** What the suggestion reads, each through its own port. */
export type NorwayPriceSetupSuggestionPorts = {
  readHubMarket: () => Promise<SettingsUiHubMarketRead>;
  readHubLocation: () => Promise<HubLocationRead>;
  homeyWebApiGet: HomeyWebApiGet;
  structuredLog?: PinoLogger;
};

type Lookup<T> = { kind: 'found'; value: T } | { kind: 'none' } | { kind: 'failed' };

type GridCompany = { organizationNumber: string; name: string };

const LOOKUP_TIMEOUT_MS = 8000;

// NVE's map of area concessions: which grid company owns the grid at a point.
// Its owner id is the company's organization number, the one PELS stores.
const NVE_GRID_COMPANY_URL = 'https://kart.nve.no/enterprise/rest/services/Nettanlegg4/MapServer/6/query';

// Kartverket's municipality lookup: the county a point is in, by the number
// PELS stores and NVE's tariff API takes.
const KARTVERKET_POINT_URL = 'https://api.kartverket.no/kommuneinfo/v1/punkt';

const HOMEY_ENERGY_ZONE_PATH = 'manager/energy/price/electricity/dynamic/zone';

const ORGANIZATION_NUMBER = /^\d{9}$/;
const COUNTY_CODE = /^\d{2}$/;
const NORWAY_ZONE_NAME = /^NO-(NO[1-5])$/;

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const fetchJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
};

/** The grid company whose area concession covers the point, from NVE's answer. */
export const classifyGridCompanyLookup = (body: unknown): Lookup<GridCompany> => {
  const features = asRecord(body)?.features;
  if (!Array.isArray(features)) return { kind: 'failed' };
  if (features.length === 0) return { kind: 'none' };
  const attributes = asRecord(asRecord(features[0])?.attributes);
  const name = attributes?.navn;
  const owner = attributes?.eier_id;
  const organizationNumber = typeof owner === 'number' || typeof owner === 'string' ? String(owner) : '';
  if (typeof name !== 'string' || name.trim() === '' || !ORGANIZATION_NUMBER.test(organizationNumber)) {
    return { kind: 'failed' };
  }
  return { kind: 'found', value: { organizationNumber, name: name.trim() } };
};

/** The county number of the point, from Kartverket's answer. */
export const classifyCountyLookup = (status: number, body: unknown): Lookup<string> => {
  // Kartverket answers a point outside Norway, such as at sea, with 404.
  if (status === 404) return { kind: 'none' };
  if (status !== 200) return { kind: 'failed' };
  const county = asRecord(body)?.fylkesnummer;
  return typeof county === 'string' && COUNTY_CODE.test(county) ? { kind: 'found', value: county } : { kind: 'failed' };
};

const zoneArea = (zone: unknown): string | null => {
  const record = asRecord(zone);
  if (record?.zoneCountryKey !== 'NO' || typeof record.zoneName !== 'string') return null;
  return NORWAY_ZONE_NAME.exec(record.zoneName)?.[1] ?? null;
};

/**
 * The Norwegian price area Homey Energy prices this hub in: the zone the owner
 * set in Homey, or else the one Homey set from the hub's location.
 */
export const classifyHomeyEnergyZone = (body: unknown): Lookup<string> => {
  const record = asRecord(body);
  if (!record) return { kind: 'failed' };
  const area = zoneArea(record.userConfigured) ?? zoneArea(record.autoConfigured);
  return area === null ? { kind: 'none' } : { kind: 'found', value: area };
};

const lookUpGridCompany = async (latitude: number, longitude: number): Promise<Lookup<GridCompany>> => {
  const search = new URLSearchParams({
    geometry: `${longitude},${latitude}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'navn,eier_id',
    returnGeometry: 'false',
    f: 'json',
  });
  try {
    const { status, body } = await fetchJson(`${NVE_GRID_COMPANY_URL}?${search.toString()}`);
    return status === 200 ? classifyGridCompanyLookup(body) : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
};

const lookUpCounty = async (latitude: number, longitude: number): Promise<Lookup<string>> => {
  const search = new URLSearchParams({ nord: String(latitude), ost: String(longitude), koordsys: '4258' });
  try {
    const { status, body } = await fetchJson(`${KARTVERKET_POINT_URL}?${search.toString()}`);
    return classifyCountyLookup(status, body);
  } catch {
    return { kind: 'failed' };
  }
};

type SuggestedGridCompany = PriceSetupSuggestion['gridCompany'];
type SuggestedPriceArea = PriceSetupSuggestion['priceArea'];

const NO_GRID_COMPANY: SuggestedGridCompany = { kind: 'none' };
const NO_PRICE_AREA: SuggestedPriceArea = { kind: 'none' };

/** A suggestion with nothing to offer. */
export const NO_PRICE_SETUP_SUGGESTION: PriceSetupSuggestion = {
  gridCompany: NO_GRID_COMPANY,
  priceArea: NO_PRICE_AREA,
};

type GridCompanyOutcome = 'not_needed' | 'not_norway' | 'no_location' | 'not_found' | 'failed' | 'found';

/** The grid company part of a suggestion, with how it was reached for the log. */
type GridCompanyAnswer = { suggestion: SuggestedGridCompany; outcome: GridCompanyOutcome };

const gridCompanyAnswer = (suggestion: SuggestedGridCompany, outcome: GridCompanyOutcome): GridCompanyAnswer => (
  { suggestion, outcome }
);

const settledAnswer = (gridCompany: SuggestedGridCompany): GridCompanyAnswer => (
  gridCompanyAnswer(gridCompany, gridCompany.kind === 'found' ? 'found' : 'not_found')
);

/**
 * Finds the Norway price settings the owner has not chosen, only when the
 * settings UI asks. The grid company lookup sends the hub's coordinates to NVE
 * and Kartverket, so it runs only while no grid company is chosen and only for
 * a hub known to be in Norway, never in the background. Its settled answer is
 * kept for that location, so opening the page again asks no one; a failed
 * lookup is asked again next time. The price area comes from Homey itself.
 */
export class NorwayPriceSetupSuggester {
  private settled: { location: string; gridCompany: SuggestedGridCompany } | null = null;

  constructor(private readonly ports: NorwayPriceSetupSuggestionPorts) {}

  async suggest(norway: NorwayPriceSetup): Promise<PriceSetupSuggestion> {
    const [gridCompany, priceArea] = await Promise.all([
      norway.gridCompany.kind === 'none' ? this.suggestGridCompany() : gridCompanyAnswer(NO_GRID_COMPANY, 'not_needed'),
      norway.priceArea.chosen ? NO_PRICE_AREA : this.readHomeyEnergyArea(),
    ]);
    this.ports.structuredLog?.info({
      event: 'price_setup_suggestion',
      gridCompany: gridCompany.outcome,
      priceArea: priceArea.kind === 'none' ? 'none' : 'found',
    });
    return { gridCompany: gridCompany.suggestion, priceArea };
  }

  private async suggestGridCompany(): Promise<GridCompanyAnswer> {
    const none = (outcome: GridCompanyOutcome) => gridCompanyAnswer(NO_GRID_COMPANY, outcome);
    // Only a hub known to be in Norway: an unread country sends the location nowhere.
    const market = await this.ports.readHubMarket();
    if (market.state !== 'resolved' || market.country !== 'NO') return none('not_norway');
    const location = await this.ports.readHubLocation();
    if (location.kind !== 'resolved') return none('no_location');
    const { latitude, longitude } = location.coordinates;
    // About 100 m: a hub that moved further is asked about again.
    const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    if (this.settled?.location === key) return settledAnswer(this.settled.gridCompany);

    const [company, county] = await Promise.all([
      lookUpGridCompany(latitude, longitude),
      lookUpCounty(latitude, longitude),
    ]);
    if (company.kind === 'failed' || county.kind === 'failed') return none('failed');
    const gridCompany: SuggestedGridCompany = company.kind === 'found' && county.kind === 'found'
      ? { kind: 'found', ...company.value, countyCode: county.value }
      : NO_GRID_COMPANY;
    this.settled = { location: key, gridCompany };
    return settledAnswer(gridCompany);
  }

  private async readHomeyEnergyArea(): Promise<SuggestedPriceArea> {
    try {
      const area = classifyHomeyEnergyZone(await this.ports.homeyWebApiGet(HOMEY_ENERGY_ZONE_PATH));
      return area.kind === 'found' ? { kind: 'from_homey_energy', area: area.value } : NO_PRICE_AREA;
    } catch {
      return NO_PRICE_AREA;
    }
  }
}
