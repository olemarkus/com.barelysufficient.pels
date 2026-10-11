import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NorwayPriceSetup, PriceSetupRead } from '../../contracts/src/settingsUiApi.ts';

const pricesRead = vi.hoisted(() => ({ priceSetup: { state: 'unavailable' } as PriceSetupRead }));

const NOTHING_CHOSEN: NorwayPriceSetup = {
  county: { value: '03', chosen: false },
  gridCompany: { kind: 'none' },
  tariffGroup: { value: 'Husholdning', chosen: false },
  pricingModel: { value: 'stromstotte', chosen: false },
  priceArea: { value: 'NO1', chosen: false },
};

const NO_GRID_COMPANY: PriceSetupRead = {
  state: 'resolved',
  setup: { source: { scheme: 'norway', basis: { kind: 'hub_location', country: 'NO' } }, norway: NOTHING_CHOSEN },
};

const load = async () => {
  vi.resetModules();
  document.body.innerHTML = `
    <div id="device-detail-price-opt-row">
      <small id="device-detail-price-source-hint" hidden></small>
    </div>
    <div id="device-detail-price-source-action" hidden></div>`;
  vi.doMock('../src/ui/dom.ts', () => ({
    deviceDetailPriceOptRow: document.querySelector('#device-detail-price-opt-row'),
  }));
  vi.doMock('../src/ui/prices.ts', () => ({
    getPricesReadModel: async () => ({
      priceSetup: pricesRead.priceSetup, homeyToday: null, homeyTomorrow: null, homeyPriceFormula: { kind: 'none' },
    }),
  }));
  return import('../src/ui/deviceDetail/priceSourceHint.ts');
};

const hint = () => document.querySelector<HTMLElement>('#device-detail-price-source-hint');
const action = () => document.querySelector<HTMLElement>('#device-detail-price-source-action');

describe('device detail price source line', () => {
  beforeEach(() => {
    pricesRead.priceSetup = { state: 'unavailable' };
  });

  it('says prices are not set up, with the way to set them up, beside Price-based control', async () => {
    pricesRead.priceSetup = NO_GRID_COMPANY;
    const { syncPriceOptRow } = await load();

    await syncPriceOptRow(true);

    expect(hint()?.hidden).toBe(false);
    expect(hint()?.classList.contains('field__hint--alert')).toBe(true);
    expect(hint()?.textContent).toBe(
      'Price setup isn’t finished. Norway, without your grid tariff. PELS uses NO1 and Strømstøtte until you choose.',
    );
    expect(action()?.hidden).toBe(false);
  });

  it('names the source of prices that are set up, with nothing to do', async () => {
    pricesRead.priceSetup = {
      state: 'resolved',
      setup: {
        source: { scheme: 'flow', basis: { kind: 'chosen' } },
        norway: NOTHING_CHOSEN,
      },
    };
    const { syncPriceOptRow } = await load();

    await syncPriceOptRow(true);

    expect(hint()?.textContent).toBe('Prices from Flow.');
    expect(hint()?.classList.contains('field__hint--alert')).toBe(false);
    expect(action()?.hidden).toBe(true);
  });

  it('hides the row and its line on a device without a temperature target, and claims nothing it cannot read', async () => {
    const { syncPriceOptRow } = await load();

    await syncPriceOptRow(true);
    expect(hint()?.hidden).toBe(true);

    await syncPriceOptRow(false);
    expect(document.querySelector<HTMLElement>('#device-detail-price-opt-row')?.hidden).toBe(true);
    expect(action()?.hidden).toBe(true);
  });
});
