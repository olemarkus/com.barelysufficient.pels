import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderElectricityPricesView, type ElectricityPricesViewProps } from '../src/ui/views/ElectricityPricesView.tsx';
import type { HomeyStatus, PowerhourStatus } from '../src/ui/priceConfigTypes.ts';
import type { PowerhourSourceUiStatus } from '../../contracts/src/settingsUiApi.ts';

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
  powerhourStatus: null,
  powerhourDeviceId: null,
  currentPriceLevel: null,
  lastFetchedShort: null,
  currentExportPriceText: null,
  planningPriceReasonLine: null,
  gridCompanyOptions: [
    { name: 'Grid Company', organizationNumber: '123' },
  ],
  showPriceAwareDevicesLink: true,
  showExportSection: false,
  showSolarForecastSection: false,
  pvForecastSource: 'auto',
  pvForecastStatus: { kind: 'unknown' },
  exportPriceEnabled: false,
  exportPriceSource: 'manual',
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
  onExportSourceChange: vi.fn(),
  onExportSpotFactorChange: vi.fn(),
  onExportFixedChange: vi.fn(),
  onPvForecastSourceChange: vi.fn(),
  onPowerhourDeviceChange: vi.fn(),
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

  it('adds the export-price row and "using your solar" reason line for a prosumer', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    renderElectricityPricesView(mount, buildProps({
      currentPriceLevel: 'cheap',
      lastFetchedShort: '14:05',
      currentExportPriceText: '0.34 kr/kWh',
      planningPriceReasonLine: 'using your solar',
    }));

    const summary = mount.querySelector('.electricity-prices-live-summary');
    expect(summary?.textContent).toContain('Export price');
    expect(summary?.textContent).toContain('0.34 kr/kWh');
    expect(summary?.querySelector('.electricity-prices-planning-reason')?.textContent)
      .toBe('using your solar');
  });

  it('stays byte-identical for a non-prosumer: no export row, no reason line', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    renderElectricityPricesView(mount, buildProps({
      currentPriceLevel: 'cheap',
      lastFetchedShort: '14:05',
      currentExportPriceText: null,
      planningPriceReasonLine: null,
    }));

    const summary = mount.querySelector('.electricity-prices-live-summary');
    expect(summary?.textContent).not.toContain('Export price');
    expect(summary?.querySelector('.electricity-prices-planning-reason')).toBeNull();
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

    it('offers no export source choice where Homey holds no feed-in terms', () => {
      // Only a home priced from Homey Energy has terms PELS can read, so
      // anywhere else the owner's own amounts are the only source and a
      // selector would be a choice with one answer.
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        priceScheme: 'norway',
      });
      expect(mount.querySelector('#electricity-prices-export-source')).toBeNull();
      expect(mount.querySelector('#electricity-prices-export-fixed')).not.toBeNull();
    });

    it('lets a Homey Energy home choose where the export price comes from', () => {
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        priceScheme: 'homey',
        exportPriceSource: 'manual',
      });
      const select = mount.querySelector('#electricity-prices-export-source');
      expect(select).not.toBeNull();
      // Still on the owner's own amounts, so the fields stay.
      expect(mount.querySelector('#electricity-prices-export-fixed')).not.toBeNull();
    });

    it("replaces the amount fields once Homey's terms are the source", () => {
      const mount = mountView({
        showExportSection: true,
        exportPriceEnabled: true,
        priceScheme: 'homey',
        exportPriceSource: 'homey_energy',
      });
      // Nothing to type: the price comes from Homey, and leaving dead fields on
      // screen would invite the owner to enter amounts PELS would not use.
      expect(mount.querySelector('#electricity-prices-export-fixed')).toBeNull();
      expect(mount.querySelector('#electricity-prices-export-spot-factor')).toBeNull();
      expect(mount.textContent).toContain('feed-in price set up in Homey');
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
      // Bare label + unit suffix + VAT basis in the hint (control-grammar unit sweep).
      expect(mount.textContent).toContain('Fixed amount');
      expect(mount.textContent).not.toContain('Fixed amount (øre/kWh, incl. VAT)');
      expect(fixed?.getAttribute('suffix-text')).toBe('øre/kWh');
      expect(mount.textContent).toContain('Added for every exported kWh, incl. VAT');
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

  describe('solar forecast section', () => {
    const mountView = (overrides: Partial<ElectricityPricesViewProps>) => {
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      renderElectricityPricesView(mount, buildProps(overrides));
      return mount;
    };

    it('stays hidden for a non-solar home on the default source', () => {
      const mount = mountView({});
      expect(mount.textContent).not.toContain('Solar forecast');
    });

    it('renders the three source choices when shown', () => {
      const mount = mountView({ showSolarForecastSection: true });
      expect(mount.textContent).toContain('Solar forecast');
      const select = mount.querySelector('#solar-forecast-source-select') as (HTMLElement & { value: string }) | null;
      expect(select?.value).toBe('auto');
      const options = Array.from(select?.querySelectorAll('md-select-option') ?? [])
        .map((option) => (option as HTMLElement & { value: string }).value);
      expect(options).toEqual(['auto', 'homey_energy', 'learned']);
    });

    it('says which forecast is in use, from the runtime provenance', () => {
      const homey = mountView({
        showSolarForecastSection: true,
        pvForecastStatus: { kind: 'selected', activeSource: 'homey_energy', homeyForecastAvailable: true, learnedForecastAvailable: false },
      });
      expect(homey.textContent).toContain('Using Homey\u2019s solar forecast.');

      const learned = mountView({
        showSolarForecastSection: true,
        pvForecastStatus: { kind: 'selected', activeSource: 'learned', homeyForecastAvailable: false, learnedForecastAvailable: true },
      });
      expect(learned.textContent).toContain('Using the forecast PELS learns from your solar production.');
    });

    it('states honestly that a pinned Homey source has no forecast yet, and names the way out', () => {
      const mount = mountView({
        showSolarForecastSection: true,
        pvForecastSource: 'homey_energy',
        pvForecastStatus: { kind: 'selected', activeSource: 'homey_energy', homeyForecastAvailable: false, learnedForecastAvailable: true },
      });
      expect(mount.textContent).toContain('Homey has no solar forecast yet, so planning runs without one.');
      expect(mount.textContent).toContain('Switch to Automatic to use the forecast PELS learns from your solar production.');
    });

    it('says so while the learned model is still learning (no forecast from either source)', () => {
      const mount = mountView({
        showSolarForecastSection: true,
        pvForecastStatus: { kind: 'selected', activeSource: 'learned', homeyForecastAvailable: false, learnedForecastAvailable: false },
      });
      expect(mount.textContent).toContain(
        'PELS is still learning your solar production, so planning runs without a forecast yet.',
      );
    });

    it('says nothing about the active source before the runtime reports', () => {
      const mount = mountView({ showSolarForecastSection: true, pvForecastStatus: { kind: 'unknown' } });
      expect(mount.textContent).not.toContain('Using ');
      expect(mount.textContent).not.toContain('no solar forecast yet');
    });

    it('routes a source change through the handler', () => {
      const onPvForecastSourceChange = vi.fn();
      const mount = mountView({ showSolarForecastSection: true, onPvForecastSourceChange });
      const select = mount.querySelector('#solar-forecast-source-select') as (HTMLElement & { value: string });
      select.value = 'homey_energy';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(onPvForecastSourceChange).toHaveBeenLastCalledWith('homey_energy');
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
  describe('Homey price setup status', () => {
    const homeyStatusWith = (issue: NonNullable<HomeyStatus['priceSetupIssue']>) => ({
      currency: 'NOK',
      currencyTone: 'ok' as const,
      today: { text: 'Loaded', tone: 'ok' as const },
      tomorrow: { text: 'Loaded', tone: 'ok' as const },
      priceSetupIssue: issue,
    });

    it('says why prices are paused when the formula cannot be used', () => {
      // Without this the owner sees empty prices and no reason anywhere.
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      renderElectricityPricesView(mount, buildProps({
        priceScheme: 'homey',
        homeyStatus: homeyStatusWith({
          value: { text: 'Not usable', tone: 'warn' },
          detail: 'Your price setup in Homey uses something PELS can’t work out (max(x, 0)).',
        }),
      }));

      expect(mount.textContent).toContain('Not usable');
      expect(mount.querySelector('#electricity-prices-setup-issue')?.textContent)
        .toContain('can’t work out');
    });

    it('stays quiet when the prices are working', () => {
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      renderElectricityPricesView(mount, buildProps({
        priceScheme: 'homey',
        homeyStatus: {
          currency: 'NOK',
          currencyTone: 'ok',
          today: { text: 'Loaded', tone: 'ok' },
          tomorrow: { text: 'Loaded', tone: 'ok' },
          priceSetupIssue: null,
        },
      }));

      expect(mount.querySelector('#electricity-prices-setup-issue')).toBeNull();
      expect(mount.textContent).not.toContain('Price setup');
    });
  });
});

const powerhourDevice = (deviceId: string, name: string) => ({
  deviceId,
  deviceName: name,
  priceIntervalMinutes: 60,
  biddingZone: '10YNO-2--------T',
});

const powerhourStatus = (
  source: PowerhourSourceUiStatus,
  hasStoredDays = true,
): PowerhourStatus => ({
  source,
  currency: '\u20ac',
  currencyTone: 'ok',
  today: { text: '12/24 hours, updated 1 min ago', tone: 'ok' },
  tomorrow: { text: 'No data received', tone: 'warn' },
  hasStoredDays,
});

const renderPowerhour = (
  source: PowerhourSourceUiStatus,
  hasStoredDays = true,
  powerhourDeviceId: string | null = null,
) => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  renderElectricityPricesView(mount, buildProps({
    priceScheme: 'powerhour',
    powerhourStatus: powerhourStatus(source, hasStoredDays),
    powerhourDeviceId,
  }));
  return mount;
};

describe('ElectricityPricesView, Power by the Hour source', () => {
  it('offers the source, and tells the flow source apart from it', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    renderElectricityPricesView(mount, buildProps());

    const labels = [...mount.querySelectorAll('#price-source-select md-select-option')]
      .map((option) => option.textContent?.trim());
    expect(labels).toContain('Power by the Hour (app)');
    // The flow option used to be the only place that name appeared; with a
    // direct source beside it, two options reading "Power by the Hour" would
    // be a coin toss for the owner.
    expect(labels).not.toContain('Flow (Power by the Hour)');
  });

  it('names the device in force and what it costs to read', () => {
    const only = powerhourDevice('no2', 'NO_Norway_2');
    const mount = renderPowerhour({ kind: 'reading', selected: only, devices: [only] });

    expect(mount.textContent).toContain('NO_Norway_2');
    expect(mount.textContent).toContain('12/24 hours');
  });

  // A failed read is a no-op, so PELS is still planning against these prices —
  // hiding them would leave the owner unable to tell whether tonight is priced.
  it('keeps showing the stored days while the source is unavailable', () => {
    const mount = renderPowerhour({ kind: 'app_unavailable' });
    expect(mount.textContent).toContain('12/24 hours');
  });

  // Each unavailable state names the place the fix is, which is never this page.
  it.each([
    [{ kind: 'app_unavailable' } as const, 'No prices from the app'],
    [{ kind: 'not_permitted' } as const, 'No access to the app'],
    [{ kind: 'no_devices' } as const, 'No price devices'],
    [{ kind: 'unknown' } as const, 'Not read yet'],
  ])('explains %o', (source, expected) => {
    const mount = renderPowerhour(source);
    expect(mount.textContent).toContain(expected);
  });

  // ...but with nothing stored there is no claim to make.
  it('shows no day counts when nothing has been stored', () => {
    const mount = renderPowerhour({ kind: 'app_unavailable' }, false);
    expect(mount.textContent).not.toContain('12/24 hours');
  });

  it('asks the owner to choose when the app has several price devices', () => {
    const devices = [powerhourDevice('no1', 'NO_Norway_1'), powerhourDevice('no2', 'NO_Norway_2')];
    const mount = renderPowerhour({ kind: 'device_missing', deviceId: '', devices });

    expect(mount.textContent).toContain('more than one price device');
    const options = [...mount.querySelectorAll('#powerhour-device-select md-select-option')]
      .map((option) => option.textContent?.trim());
    expect(options).toHaveLength(3);
    expect(options).toContain('NO_Norway_1 (hourly prices)');
  });

  // One device is not a choice; a select with a single option is a question the
  // owner cannot answer usefully.
  it('offers no device picker on a home with one price device', () => {
    const only = powerhourDevice('no2', 'NO_Norway_2');
    const mount = renderPowerhour({ kind: 'reading', selected: only, devices: [only] });

    expect(mount.querySelector('#powerhour-device-select')).toBeNull();
    // ...and with no picker, the row is the only place the device is named.
    expect(mount.textContent).toContain('NO_Norway_2');
  });

  // ...but once the chosen device is gone the copy asks them to pick another,
  // and PELS will not adopt the survivor on their behalf — so a picker with one
  // option is the only way that sentence is answerable.
  it('still offers the picker when the chosen device has gone and one is left', () => {
    const survivor = powerhourDevice('no1', 'NO_Norway_1');
    const mount = renderPowerhour({ kind: 'device_missing', deviceId: 'no2', devices: [survivor] });

    expect(mount.querySelector('#powerhour-device-select')).not.toBeNull();
    expect(mount.textContent).toContain('Pick another one below');
    expect(mount.textContent).toContain('Price device is gone');
  });

  // The picker's closed field already reads the name; a status row repeating it
  // is the doubling this page retired once already.
  it('does not name the device twice when the picker renders', () => {
    const devices = [powerhourDevice('no1', 'NO_Norway_1'), powerhourDevice('no2', 'NO_Norway_2')];
    const mount = renderPowerhour({ kind: 'reading', selected: devices[1]!, devices });

    expect(mount.textContent).toContain('Reading prices');
    expect(mount.textContent?.match(/NO_Norway_2 \(hourly prices\)/g) ?? []).toHaveLength(1);
  });
});
