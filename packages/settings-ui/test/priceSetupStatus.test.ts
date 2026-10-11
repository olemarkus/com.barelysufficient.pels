import { describe, expect, it } from 'vitest';
import {
  resolveNorwayChoices,
  resolvePriceSetupStatus,
  resolvePriceSourceAssumption,
} from '../src/ui/priceSetupStatus.ts';
import type {
  NorwayPriceSetup,
  PriceSetupRead,
  ResolvedPriceScheme,
  SettingsUiPricesPayload,
} from '../../contracts/src/settingsUiApi.ts';

const NOTHING_CHOSEN: NorwayPriceSetup = {
  county: { value: '03', chosen: false },
  gridCompany: { kind: 'none' },
  tariffGroup: { value: 'Husholdning', chosen: false },
  pricingModel: { value: 'stromstotte', chosen: false },
  priceArea: { value: 'NO1', chosen: false },
};

const ARVA_NORGESPRIS_NO4: NorwayPriceSetup = {
  county: { value: '55', chosen: true },
  gridCompany: { kind: 'chosen', organizationNumber: '979151950' },
  tariffGroup: { value: 'Husholdning', chosen: true },
  pricingModel: { value: 'norgespris', chosen: true },
  priceArea: { value: 'NO4', chosen: true },
};

const CHOSEN = { kind: 'chosen' } as const;
const IN_NETHERLANDS = { kind: 'hub_location', country: 'NL' } as const;

const readOf = (source: ResolvedPriceScheme, norway: NorwayPriceSetup = NOTHING_CHOSEN): PriceSetupRead => (
  { state: 'resolved', setup: { source, norway } }
);

const HOMEY_DAY = { dateKey: '2026-10-11', pricesByHour: { 0: 0.2 }, updatedAt: '2026-10-11T00:00:00Z' };

const statusOf = (
  priceSetup: PriceSetupRead,
  homeyToday: unknown = null,
  homeyPriceFormula: SettingsUiPricesPayload['homeyPriceFormula'] = { kind: 'applied' },
) => (
  resolvePriceSetupStatus({ priceSetup, homeyToday, homeyTomorrow: null, homeyPriceFormula })
);

describe('resolvePriceSourceAssumption', () => {
  it('says why PELS picked the source the owner never chose', () => {
    expect(resolvePriceSourceAssumption(readOf({ scheme: 'homey', basis: IN_NETHERLANDS }), 'homey'))
      .toEqual({ kind: 'assumed', reason: 'outside_norway' });
    expect(resolvePriceSourceAssumption(
      readOf({ scheme: 'norway', basis: { kind: 'hub_location', country: 'NO' } }),
      'norway',
    )).toEqual({ kind: 'assumed', reason: 'in_norway' });
    expect(resolvePriceSourceAssumption(readOf({ scheme: 'norway', basis: { kind: 'default' } }), 'norway'))
      .toEqual({ kind: 'assumed', reason: 'location_unknown' });
  });

  it('claims nothing about a chosen source, a read it lacks, or a source the page no longer shows', () => {
    expect(resolvePriceSourceAssumption(readOf({ scheme: 'flow', basis: CHOSEN }), 'flow')).toEqual({ kind: 'none' });
    expect(resolvePriceSourceAssumption({ state: 'unavailable' }, 'norway')).toEqual({ kind: 'none' });
    // The owner just picked Norway; the cached read still describes the assumed source.
    expect(resolvePriceSourceAssumption(readOf({ scheme: 'homey', basis: IN_NETHERLANDS }), 'norway'))
      .toEqual({ kind: 'none' });
  });
});

describe('resolveNorwayChoices', () => {
  it('carries which settings the owner chose, with the values PELS prices with, and nothing without the read', () => {
    expect(resolveNorwayChoices(readOf({ scheme: 'norway', basis: CHOSEN }, {
      ...NOTHING_CHOSEN,
      pricingModel: { value: 'norgespris', chosen: true },
    }))).toEqual({
      kind: 'resolved',
      choices: {
        county: { value: '03', chosen: false },
        pricingModel: { value: 'norgespris', chosen: true },
        priceArea: { value: 'NO1', chosen: false },
      },
    });
    expect(resolveNorwayChoices({ state: 'unavailable' })).toEqual({ kind: 'unknown' });
  });
});

describe('resolvePriceSetupStatus', () => {
  it('is complete on Norway once the grid company, price area and pricing model are chosen', () => {
    expect(statusOf(readOf({ scheme: 'norway', basis: CHOSEN }, ARVA_NORGESPRIS_NO4)))
      .toEqual({ state: 'complete', summary: 'Norway · ARVA AS · NO4 · Norgespris' });
  });

  it('is complete on Norway only once the source itself is chosen', () => {
    expect(statusOf(readOf({ scheme: 'norway', basis: { kind: 'hub_location', country: 'NO' } }, ARVA_NORGESPRIS_NO4)))
      .toEqual({ state: 'open', summary: 'PELS uses the Norway source until you choose one.' });
  });

  it('names what Norway prices with until the owner chooses', () => {
    expect(statusOf(readOf({ scheme: 'norway', basis: { kind: 'hub_location', country: 'NO' } }))).toEqual({
      state: 'open',
      summary: 'Norway, without your grid tariff. PELS uses NO1 and Strømstøtte until you choose.',
    });
    expect(statusOf(readOf({ scheme: 'norway', basis: CHOSEN }, {
      ...ARVA_NORGESPRIS_NO4,
      priceArea: { value: 'NO1', chosen: false },
    }))).toEqual({ state: 'open', summary: 'Norway · ARVA AS. PELS uses NO1 until you choose.' });
    expect(statusOf(readOf({ scheme: 'norway', basis: CHOSEN }, {
      ...ARVA_NORGESPRIS_NO4,
      gridCompany: { kind: 'none' },
    }))).toEqual({
      state: 'open',
      summary: 'Norway, without your grid tariff. Choose your grid company to include it.',
    });
  });

  it('is open on Homey Energy while Homey has no prices for the hub, whoever chose it', () => {
    expect(statusOf(readOf({ scheme: 'homey', basis: CHOSEN })))
      .toEqual({ state: 'open', summary: 'Homey Energy has no electricity prices for your Homey yet.' });
  });

  it('is open on Homey Energy while PELS cannot work out its price setup', () => {
    expect(statusOf(readOf({ scheme: 'homey', basis: CHOSEN }), HOMEY_DAY, { kind: 'prices_nothing', expression: 'x' }))
      .toEqual({ state: 'open', summary: 'PELS can’t use the price setup in Homey Energy.' });
  });

  it('is open on a source PELS assumed until the owner keeps it', () => {
    expect(statusOf(readOf({ scheme: 'homey', basis: IN_NETHERLANDS }), HOMEY_DAY))
      .toEqual({ state: 'open', summary: 'PELS uses Homey Energy until you choose a source.' });
    expect(statusOf(readOf({ scheme: 'homey', basis: CHOSEN }), HOMEY_DAY))
      .toEqual({ state: 'complete', summary: 'Homey Energy' });
    expect(statusOf(readOf({ scheme: 'flow', basis: CHOSEN }))).toEqual({ state: 'complete', summary: 'Flow' });
  });

  it('claims nothing without the read', () => {
    expect(statusOf({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
  });
});
