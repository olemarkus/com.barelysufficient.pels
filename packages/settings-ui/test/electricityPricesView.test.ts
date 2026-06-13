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
  currentPriceLevel: null,
  lastFetchedShort: null,
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

  it('gives the grid-company placeholder a non-empty value so md-select never shows a blank field, and maps it back to empty on change', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const onOrganizationChange = vi.fn();
    renderElectricityPricesView(mount, buildProps({ organizationNumber: '', onOrganizationChange }));

    const gridSelect = mount.querySelector(
      'md-filled-select[aria-labelledby="electricity-prices-grid-company-label"]',
    ) as (HTMLElement & { value: string }) | null;
    expect(gridSelect).not.toBeNull();

    // md-select renders nothing in the closed field for an empty value, so the
    // placeholder option must carry a non-empty sentinel value while still
    // reading "Select grid company".
    const placeholderOption = gridSelect?.querySelector('md-select-option') as (HTMLElement & { value: string }) | null;
    expect(placeholderOption?.textContent).toContain('Select grid company');
    expect(placeholderOption?.value).toBeTruthy();
    const sentinel = placeholderOption!.value;

    // Picking the placeholder must surface as an empty organization number, never
    // the internal sentinel; picking a real company passes its value through.
    const fireChange = (value: string) => {
      if (gridSelect) {
        gridSelect.value = value;
        gridSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    fireChange(sentinel);
    expect(onOrganizationChange).toHaveBeenLastCalledWith('');
    fireChange('123');
    expect(onOrganizationChange).toHaveBeenLastCalledWith('123');
  });

  it('renders the canonical price-level chip and last-fetched time in the summary card', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    renderElectricityPricesView(mount, buildProps({
      currentPriceLevel: 'expensive',
      lastFetchedShort: '14:05',
    }));

    const summary = mount.querySelector('.electricity-prices-live-summary');
    expect(summary).not.toBeNull();
    const chip = summary?.querySelector('.plan-chip');
    // Canonical "Price high" pair from priceLevelChips.ts, with the warn tone.
    expect(chip?.textContent?.trim()).toBe('Price high');
    expect(chip?.classList.contains('plan-chip--warn')).toBe(true);
    expect(chip?.getAttribute('data-price-level')).toBe('expensive');
    expect(summary?.textContent).toContain('14:05');
  });

  it('stays calm (no chip) for normal price level and shows a dash when never fetched', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    renderElectricityPricesView(mount, buildProps({
      currentPriceLevel: 'normal',
      lastFetchedShort: null,
    }));

    const summary = mount.querySelector('.electricity-prices-live-summary');
    expect(summary?.querySelector('.plan-chip')).toBeNull();
    expect(summary?.textContent).toContain('Normal');
    expect(summary?.textContent).toContain('—');
  });

  it('shows "Awaiting prices" (not "Normal") for the unknown level before prices arrive', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    renderElectricityPricesView(mount, buildProps({
      currentPriceLevel: 'unknown',
      lastFetchedShort: null,
    }));

    const summary = mount.querySelector('.electricity-prices-live-summary');
    expect(summary?.querySelector('.plan-chip')).toBeNull();
    expect(summary?.textContent).toContain('Awaiting prices');
    expect(summary?.textContent).not.toContain('Normal');
  });

  it('hides the last-fetched timestamp while awaiting prices (no fetched-vs-awaiting contradiction)', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    // Post-midnight / partial-fetch window: a fetch completed (06:31) but no
    // price covers the current hour, so the level is unknown. The card must not
    // claim "Last fetched 06:31" next to "Awaiting prices".
    renderElectricityPricesView(mount, buildProps({
      currentPriceLevel: 'unknown',
      lastFetchedShort: '06:31',
    }));

    const summary = mount.querySelector('.electricity-prices-live-summary');
    expect(summary?.textContent).toContain('Awaiting prices');
    expect(summary?.textContent).not.toContain('06:31');
    expect(summary?.textContent).not.toContain('Last fetched');
  });
});
