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
  showExportSection: false,
  exportPriceEnabled: false,
  exportSpotFactor: 0,
  exportFixed: 0,
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
  onExportEnabledChange: vi.fn(),
  onExportSpotFactorChange: vi.fn(),
  onExportFixedChange: vi.fn(),
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

  describe('export price section', () => {
    const mountView = (overrides: Partial<ElectricityPricesViewProps>) => {
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      renderElectricityPricesView(mount, buildProps(overrides));
      return mount;
    };

    it('renders no export section when the prosumer gate is off', () => {
      const mount = mountView({ showExportSection: false });
      expect(mount.querySelector('#electricity-prices-export-section')).toBeNull();
    });

    it('shows only the toggle while export pricing is off', () => {
      const mount = mountView({ showExportSection: true, exportPriceEnabled: false });
      const section = mount.querySelector('#electricity-prices-export-section');
      expect(section).not.toBeNull();
      expect(section?.querySelector('#electricity-prices-export-enabled')).not.toBeNull();
      // Fields stay structurally absent (not CSS-hidden) until the toggle is on.
      expect(section?.querySelector('#electricity-prices-export-spot-factor')).toBeNull();
      expect(section?.querySelector('#electricity-prices-export-fixed')).toBeNull();
    });

    it('reveals both fields with Norwegian units when enabled on the norway scheme', () => {
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        exportSpotFactor: 90,
        exportFixed: -5,
        priceScheme: 'norway',
      });
      const factor = mount.querySelector('#electricity-prices-export-spot-factor') as (HTMLElement & { value: string; disabled?: boolean }) | null;
      const fixed = mount.querySelector('#electricity-prices-export-fixed') as (HTMLElement & { value: string }) | null;
      expect(factor?.value).toBe('90');
      expect(Boolean(factor?.disabled)).toBe(false);
      expect(fixed?.value).toBe('-5');
      expect(mount.textContent).toContain('Fixed amount (øre/kWh, incl. VAT)');
      expect(mount.textContent).not.toContain('Needs a spot price');
      // The hint states the VAT-inclusive basis and the raw-spot conversion
      // recipe (a raw-spot contract enters 80, not 100).
      expect(mount.textContent).toContain('Share of the hourly spot price (incl. VAT)');
      expect(mount.textContent).toContain('If your contract pays the raw spot price, enter 80');
    });

    it('disables a settled spot-price share (0) with the fixed-only note on flow/homey schemes', () => {
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        exportSpotFactor: 0,
        priceScheme: 'flow',
      });
      const factor = mount.querySelector('#electricity-prices-export-spot-factor') as (HTMLElement & { value: string; disabled?: boolean }) | null;
      expect(factor?.value).toBe('0');
      expect(Boolean(factor?.disabled)).toBe(true);
      expect(mount.textContent).toContain('Needs a spot price');
      expect(mount.textContent).toContain('Only the fixed amount applies');
      expect(mount.textContent).not.toContain('Set the share to 0');
      // External schemes drop the Norwegian unit from the fixed-amount label.
      expect(mount.textContent).toContain('Fixed amount');
      expect(mount.textContent).not.toContain('Fixed amount (øre/kWh, incl. VAT)');
    });

    it('surfaces a stored non-zero share on a spot-less scheme as editable with the repair note', () => {
      // A stale spot-linked share (CLI-set, or a failed normalization write)
      // yields NO export price at all — the field must show the real value,
      // stay editable so the user can zero it, and name the repair, never
      // pretend a working 0.
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        exportSpotFactor: 90,
        priceScheme: 'flow',
      });
      const factor = mount.querySelector('#electricity-prices-export-spot-factor') as (HTMLElement & { value: string; disabled?: boolean }) | null;
      expect(factor?.value).toBe('90');
      expect(Boolean(factor?.disabled)).toBe(false);
      expect(mount.textContent).toContain('Needs a spot price');
      expect(mount.textContent).toContain('Set the share to 0 to use the fixed amount only');
      expect(mount.textContent).not.toContain('Only the fixed amount applies.');
    });

    it('routes toggle and field changes through the handlers', () => {
      const onExportEnabledChange = vi.fn();
      const onExportSpotFactorChange = vi.fn();
      const onExportFixedChange = vi.fn();
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        onExportEnabledChange,
        onExportSpotFactorChange,
        onExportFixedChange,
      });

      const toggle = mount.querySelector('#electricity-prices-export-enabled') as (HTMLElement & { selected: boolean }) | null;
      expect(toggle).not.toBeNull();
      toggle!.selected = false;
      toggle!.dispatchEvent(new Event('change', { bubbles: true }));
      expect(onExportEnabledChange).toHaveBeenLastCalledWith(false);

      const fireChange = (selector: string, value: string) => {
        const field = mount.querySelector(selector) as (HTMLElement & { value: string });
        field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      // Numeric handlers also receive the field element (the snap-back seam).
      fireChange('#electricity-prices-export-spot-factor', '85');
      expect(onExportSpotFactorChange).toHaveBeenLastCalledWith(85, expect.anything());
      fireChange('#electricity-prices-export-fixed', '-2.5');
      expect(onExportFixedChange).toHaveBeenLastCalledWith(-2.5, expect.anything());
      // Non-finite input never reaches the handler (boundary gate).
      fireChange('#electricity-prices-export-fixed', 'junk');
      expect(onExportFixedChange).toHaveBeenCalledTimes(1);
    });
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
