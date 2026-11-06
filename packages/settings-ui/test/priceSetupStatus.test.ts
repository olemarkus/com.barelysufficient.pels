import { describe, expect, it, vi } from 'vitest';
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
} from '../../contracts/src/settingsUi/prices.ts';

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
  powerhourToday: unknown = null,
) => (
  resolvePriceSetupStatus({
    priceSetup, homeyToday, homeyTomorrow: null, homeyPriceFormula, powerhourToday, powerhourTomorrow: null,
    flowToday: null, flowTomorrow: null, combinedPrices: null,
  })
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
      .toEqual({ state: 'open', summary: 'Homey Energy has no prices for your Homey.' });
  });

  it('is open on Power by the Hour until it has given PELS prices, whoever chose it', () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    try {
      // Chosen while the app is not running, or before it has a price device.
      expect(statusOf(readOf({ scheme: 'powerhour', basis: CHOSEN })))
        .toEqual({ state: 'open', summary: 'Power by the Hour has no prices yet.' });
      expect(statusOf(readOf({ scheme: 'powerhour', basis: CHOSEN }), null, { kind: 'applied' }, HOMEY_DAY))
        .toEqual({ state: 'complete', summary: 'Power by the Hour' });
      // A day kept from before the app stopped is not prices.
      vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
      expect(statusOf(readOf({ scheme: 'powerhour', basis: CHOSEN }), null, { kind: 'applied' }, HOMEY_DAY))
        .toEqual({ state: 'open', summary: 'Power by the Hour has no prices yet.' });
    } finally {
      vi.useRealTimers();
    }
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
  });

  it('keeps Flow setup open without a usable current day, even after choosing the source', () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    try {
      const priceSetup = readOf({ scheme: 'flow', basis: CHOSEN });
      const missing = { state: 'open', summary: 'Send today’s or tomorrow’s prices through a Flow.' };
      expect(statusOf(priceSetup)).toEqual(missing);
      for (const flowToday of [
        { ...HOMEY_DAY, pricesByHour: {} },
        { ...HOMEY_DAY, pricesByHour: { 0: 'not a price' } },
        { ...HOMEY_DAY, dateKey: '2026-10-10' },
      ]) {
        expect(resolvePriceSetupStatus({
          priceSetup, homeyToday: HOMEY_DAY, homeyTomorrow: null, homeyPriceFormula: { kind: 'none' },
          powerhourToday: HOMEY_DAY, powerhourTomorrow: null, flowToday, flowTomorrow: null, combinedPrices: null,
        })).toEqual(missing);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes Flow setup with prices for either today or tomorrow without requiring both', () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    try {
      for (const [flowToday, flowTomorrow] of [
        [{ ...HOMEY_DAY, pricesByHour: { 0: 0 } }, null],
        [null, { ...HOMEY_DAY, dateKey: '2026-10-12', pricesByHour: { 0: -0.2 } }],
      ]) {
        expect(resolvePriceSetupStatus({
          priceSetup: readOf({ scheme: 'flow', basis: CHOSEN }),
          homeyToday: null, homeyTomorrow: null, homeyPriceFormula: { kind: 'none' },
          powerhourToday: null, powerhourTomorrow: null, flowToday, flowTomorrow, combinedPrices: null,
        })).toEqual({ state: 'complete', summary: 'Flow' });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Flow setup complete while the runtime retains current Flow prices', () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    try {
      const statusWith = (combinedPrices: unknown) => resolvePriceSetupStatus({
        priceSetup: readOf({ scheme: 'flow', basis: CHOSEN }),
        homeyToday: null, homeyTomorrow: null, homeyPriceFormula: { kind: 'none' },
        powerhourToday: null, powerhourTomorrow: null, flowToday: null, flowTomorrow: null, combinedPrices,
      });
      const retained = { priceScheme: 'flow', prices: [{ startsAt: '2026-10-11T12:00:00Z', total: 0 }] };
      expect(statusWith(retained)).toEqual({ state: 'complete', summary: 'Flow' });
      expect(statusWith({ priceScheme: 'flow', days: { '2026-10-12': {
        hours: [{ startsAt: '2026-10-12T12:00:00Z', total: -0.2 }],
      } } })).toEqual({ state: 'complete', summary: 'Flow' });
      for (const combined of [
        { ...retained, priceScheme: 'homey' },
        { ...retained, prices: [{ startsAt: '2026-10-10T12:00:00Z', total: 0.2 }] },
        { ...retained, prices: [{ startsAt: 'invalid', total: 0.2 }] },
        { ...retained, prices: [{ startsAt: '2026-10-11T12:00:00Z', total: 'invalid' }] },
      ]) {
        expect(statusWith(combined)).toEqual({
          state: 'open', summary: 'Send today’s or tomorrow’s prices through a Flow.',
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims nothing without the read', () => {
    expect(statusOf({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
  });
});
