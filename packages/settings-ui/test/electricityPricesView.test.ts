import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderElectricityPricesView, type ElectricityPricesViewProps } from '../src/ui/views/ElectricityPricesView.tsx';

const buildProps = (overrides: Partial<ElectricityPricesViewProps> = {}): ElectricityPricesViewProps => ({
  thresholdPercent: 20,
  minDiffOre: 5,
  priceScheme: 'norway',
  norwayPriceModel: 'stromstotte',
  priceArea: 'NO1',
  providerSurcharge: 0,
  countyCode: '03',
  organizationNumber: '123',
  tariffGroup: 'Husholdning',
  flowStatus: null,
  homeyStatus: null,
  gridCompanyOptions: [
    { name: 'Grid Company', organizationNumber: '123' },
  ],
  showPriceAwareDevicesLink: true,
  onSchemeChange: vi.fn(),
  onNorwayModelChange: vi.fn(),
  onPriceAreaChange: vi.fn(),
  onProviderSurchargeChange: vi.fn(),
  onThresholdChange: vi.fn(),
  onMinDiffChange: vi.fn(),
  onCountyChange: vi.fn(),
  onOrganizationChange: vi.fn(),
  onTariffGroupChange: vi.fn(),
  onRefreshPrices: vi.fn(),
  onRefreshGridTariff: vi.fn(),
  ...overrides,
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('ElectricityPricesView', () => {
  it('keeps in-form refresh Material buttons out of submit mode', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    renderElectricityPricesView(mount, buildProps());

    const refreshButtons = Array.from(mount.querySelectorAll('form md-outlined-button'))
      .filter((button) => button.textContent?.includes('Refresh'));

    expect(refreshButtons.map((button) => button.textContent?.trim())).toEqual([
      'Refresh tariffs',
      'Refresh prices',
    ]);
    refreshButtons.forEach((button) => {
      expect((button as HTMLElement & { type?: string }).type).toBe('button');
    });
  });
});
