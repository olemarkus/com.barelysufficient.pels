import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  classifyCountyLookup,
  classifyGridCompanyLookup,
  classifyHomeyEnergyZone,
  NorwayPriceSetupSuggester,
  type HubLocationRead,
} from '../../lib/price/norwayPriceSetupSuggestion';
import type { NorwayPriceSetup } from '../../packages/contracts/src/settingsUi/prices';
import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUi/webApp';
import { testLogger } from '../utils/testLogger';

const NVE_TRONDHEIM = {
  displayFieldName: 'KONSTYPE',
  fields: [{ name: 'navn' }, { name: 'eier_id' }],
  features: [{ attributes: { navn: 'TENSIO TS AS', eier_id: 978631029 } }],
};
const NVE_AT_SEA = { displayFieldName: 'KONSTYPE', fields: [], features: [] };
const KARTVERKET_TRONDHEIM = {
  fylkesnavn: 'Trøndelag', fylkesnummer: '50', kommunenavn: 'Trondheim', kommunenummer: '5001',
};
// The configured zone can differ from the zone Homey derives from location.
const ZONE_USER_ELSEWHERE = {
  userConfigured: { zoneId: '10YBE----------2', zoneName: 'BE', zoneCountryKey: 'BE' },
  autoConfigured: { zoneId: '10YNO-3--------J', zoneName: 'NO-NO3', zoneCountryKey: 'NO' },
};

const TRONDHEIM: HubLocationRead = { kind: 'resolved', coordinates: { latitude: 63.43, longitude: 10.39 } };
const IN_NORWAY: SettingsUiHubMarketRead = { state: 'resolved', country: 'NO' };

describe('classifyGridCompanyLookup', () => {
  it('reads the grid company and its organization number', () => {
    expect(classifyGridCompanyLookup(NVE_TRONDHEIM))
      .toEqual({ kind: 'found', value: { organizationNumber: '978631029', name: 'TENSIO TS AS' } });
    expect(classifyGridCompanyLookup({ features: [{ attributes: { navn: 'ARVA AS', eier_id: '979151950' } }] }))
      .toEqual({ kind: 'found', value: { organizationNumber: '979151950', name: 'ARVA AS' } });
  });

  it('tells a point no company covers from an answer it cannot read', () => {
    expect(classifyGridCompanyLookup(NVE_AT_SEA)).toEqual({ kind: 'none' });
    expect(classifyGridCompanyLookup({ error: { code: 400 } })).toEqual({ kind: 'failed' });
    expect(classifyGridCompanyLookup({ features: [{ attributes: { navn: 'X', eier_id: 12 } }] }))
      .toEqual({ kind: 'failed' });
    expect(classifyGridCompanyLookup(null)).toEqual({ kind: 'failed' });
  });
});

describe('classifyCountyLookup', () => {
  it('reads the county number, and a point outside Norway as none', () => {
    expect(classifyCountyLookup(200, KARTVERKET_TRONDHEIM)).toEqual({ kind: 'found', value: '50' });
    expect(classifyCountyLookup(404, null)).toEqual({ kind: 'none' });
  });

  it('fails on anything else', () => {
    expect(classifyCountyLookup(500, null)).toEqual({ kind: 'failed' });
    expect(classifyCountyLookup(200, { fylkesnummer: 50 })).toEqual({ kind: 'failed' });
  });
});

describe('classifyHomeyEnergyZone', () => {
  it('preserves both Norwegian zones when the configured and location-derived zones disagree', () => {
    expect(classifyHomeyEnergyZone({
      userConfigured: { zoneName: 'NO-NO3', zoneCountryKey: 'NO' },
      autoConfigured: { zoneName: 'NO-NO1', zoneCountryKey: 'NO' },
    })).toEqual({ kind: 'conflict', homeyEnergyArea: 'NO3', locationArea: 'NO1' });
  });

  it('offers a single area when the Norwegian zones agree or only one is usable', () => {
    const zone = { zoneName: 'NO-NO3', zoneCountryKey: 'NO' };
    const offer = { kind: 'from_homey_energy', area: 'NO3' };
    expect(classifyHomeyEnergyZone({ userConfigured: zone, autoConfigured: zone })).toEqual(offer);
    expect(classifyHomeyEnergyZone({ userConfigured: zone })).toEqual(offer);
    expect(classifyHomeyEnergyZone(ZONE_USER_ELSEWHERE)).toEqual(offer);
  });

  it('has no area outside Norway, and fails on an unreadable answer', () => {
    expect(classifyHomeyEnergyZone({ autoConfigured: { zoneName: 'BE', zoneCountryKey: 'BE' } }))
      .toEqual({ kind: 'none' });
    expect(classifyHomeyEnergyZone({})).toEqual({ kind: 'none' });
    expect(classifyHomeyEnergyZone('x')).toEqual({ kind: 'failed' });
  });
});

const NOTHING_CHOSEN: NorwayPriceSetup = {
  county: { value: '03', chosen: false },
  gridCompany: { kind: 'none' },
  tariffGroup: { value: 'Husholdning', chosen: false },
  pricingModel: { value: 'stromstotte', chosen: false },
  priceArea: { value: 'NO1', chosen: false },
};
const COMPANY_CHOSEN: NorwayPriceSetup = {
  ...NOTHING_CHOSEN,
  gridCompany: { kind: 'chosen', organizationNumber: '978631029' },
};
const TENSIO = { kind: 'found', organizationNumber: '978631029', name: 'TENSIO TS AS', countyCode: '50' };

describe('NorwayPriceSetupSuggester', () => {
  let fetchMock: Mock;

  const respond = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });

  const answerLookups = (nve: unknown, kartverket: { status: number; body: unknown }) => {
    fetchMock.mockImplementation(async (url: string) => (
      url.startsWith('https://kart.nve.no/') ? respond(200, nve) : respond(kartverket.status, kartverket.body)
    ));
  };

  const suggester = (overrides: {
    market?: SettingsUiHubMarketRead;
    location?: HubLocationRead;
    zone?: () => Promise<unknown>;
  } = {}) => new NorwayPriceSetupSuggester({
    structuredLog: testLogger,
    readHubMarket: async () => overrides.market ?? IN_NORWAY,
    readHubLocation: async () => overrides.location ?? TRONDHEIM,
    homeyWebApiGet: overrides.zone ?? (async () => ZONE_USER_ELSEWHERE),
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('suggests the grid company with its county, and the price area, for the hub\'s location', async () => {
    answerLookups(NVE_TRONDHEIM, { status: 200, body: KARTVERKET_TRONDHEIM });

    await expect(suggester().suggest(NOTHING_CHOSEN)).resolves.toEqual({
      gridCompany: TENSIO,
      priceArea: { kind: 'from_homey_energy', area: 'NO3' },
    });
    const nveUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(nveUrl.searchParams.get('geometry')).toBe('10.39,63.43');
  });

  it('returns an area conflict alongside the grid company and county', async () => {
    answerLookups(NVE_TRONDHEIM, { status: 200, body: KARTVERKET_TRONDHEIM });

    const zone = async () => ({
      userConfigured: { zoneName: 'NO-NO1', zoneCountryKey: 'NO' },
      autoConfigured: { zoneName: 'NO-NO3', zoneCountryKey: 'NO' },
    });
    await expect(suggester({ zone }).suggest(NOTHING_CHOSEN)).resolves.toEqual({
      gridCompany: TENSIO,
      priceArea: { kind: 'conflict', homeyEnergyArea: 'NO1', locationArea: 'NO3' },
    });
  });

  it('asks no one again for the same location', async () => {
    answerLookups(NVE_TRONDHEIM, { status: 200, body: KARTVERKET_TRONDHEIM });
    const subject = suggester();

    const first = await subject.suggest(NOTHING_CHOSEN);
    await expect(subject.suggest(NOTHING_CHOSEN)).resolves.toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the location nowhere once the owner chose a grid company, and still finds the price area', async () => {
    await expect(suggester().suggest(COMPANY_CHOSEN)).resolves.toEqual({
      gridCompany: { kind: 'none' },
      priceArea: { kind: 'from_homey_energy', area: 'NO3' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads no zone once the owner chose the price area', async () => {
    answerLookups(NVE_TRONDHEIM, { status: 200, body: KARTVERKET_TRONDHEIM });
    const zone = vi.fn();

    await expect(suggester({ zone }).suggest({ ...NOTHING_CHOSEN, priceArea: { value: 'NO4', chosen: true } }))
      .resolves.toEqual({ gridCompany: TENSIO, priceArea: { kind: 'none' } });
    expect(zone).not.toHaveBeenCalled();
  });

  it.each([
    ['outside Norway', { state: 'resolved', country: 'SE' } as const],
    ['whose country is not known', { state: 'unavailable' } as const],
  ])('sends the location nowhere for a hub %s', async (_label, market) => {
    await expect(suggester({ market }).suggest(NOTHING_CHOSEN)).resolves.toMatchObject({ gridCompany: { kind: 'none' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing for a hub without a location', async () => {
    await expect(suggester({ location: { kind: 'unavailable' } }).suggest(NOTHING_CHOSEN))
      .resolves.toMatchObject({ gridCompany: { kind: 'none' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suggests no grid company where none is, and keeps that answer', async () => {
    answerLookups(NVE_AT_SEA, { status: 404, body: null });
    const subject = suggester();

    await expect(subject.suggest(NOTHING_CHOSEN)).resolves.toMatchObject({ gridCompany: { kind: 'none' } });
    await subject.suggest(NOTHING_CHOSEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks again after a failed lookup, and keeps the price area meanwhile', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    fetchMock.mockResolvedValue(respond(200, KARTVERKET_TRONDHEIM));
    const subject = suggester();

    await expect(subject.suggest(NOTHING_CHOSEN)).resolves.toEqual({
      gridCompany: { kind: 'none' },
      priceArea: { kind: 'from_homey_energy', area: 'NO3' },
    });
    answerLookups(NVE_TRONDHEIM, { status: 200, body: KARTVERKET_TRONDHEIM });
    await expect(subject.suggest(NOTHING_CHOSEN)).resolves.toMatchObject({ gridCompany: TENSIO });
  });

  it('suggests no price area when Homey Energy does not answer', async () => {
    answerLookups(NVE_TRONDHEIM, { status: 200, body: KARTVERKET_TRONDHEIM });
    const zone = vi.fn().mockRejectedValue(new Error('busy'));

    await expect(suggester({ zone }).suggest(NOTHING_CHOSEN))
      .resolves.toEqual({ gridCompany: TENSIO, priceArea: { kind: 'none' } });
  });
});
