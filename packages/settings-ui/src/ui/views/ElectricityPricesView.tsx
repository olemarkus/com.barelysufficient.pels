import { render } from 'preact';
import type {
  PriceScheme,
  NorwayPriceModel,
  FlowStatus,
  HomeyStatus,
  GridCompanyOption,
} from '../priceConfigTypes.ts';
import {
  MdFilledSelect,
  MdFilledTextField,
  MdOutlinedButton,
  MdSelectOption,
  MdTextButton,
} from './materialWebJSX.tsx';
import { ArrowBackIcon } from './icons.tsx';

type ValueElement = HTMLElement & { value: string };

const readValue = (event: Event): string => (event.currentTarget as ValueElement).value;

const readFiniteNumber = (event: Event): number | null => {
  const value = Number.parseFloat(readValue(event));
  return Number.isFinite(value) ? value : null;
};

export type ElectricityPricesViewProps = {
  thresholdPercent: number;
  minDiffOre: number;
  priceScheme: PriceScheme;
  norwayPriceModel: NorwayPriceModel;
  priceArea: string;
  providerSurcharge: number;
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
  flowStatus: FlowStatus | null;
  homeyStatus: HomeyStatus | null;
  gridCompanyOptions: GridCompanyOption[];
  showPriceAwareDevicesLink: boolean;
  onSchemeChange: (scheme: PriceScheme) => void;
  onNorwayModelChange: (model: NorwayPriceModel) => void;
  onPriceAreaChange: (area: string) => void;
  onProviderSurchargeChange: (val: number) => void;
  onThresholdChange: (val: number) => void;
  onMinDiffChange: (val: number) => void;
  onCountyChange: (code: string) => void;
  onOrganizationChange: (orgNumber: string) => void;
  onTariffGroupChange: (group: string) => void;
  onRefreshPrices: () => void;
  onRefreshGridTariff: () => void;
};

const Header = () => (
  <>
    <MdTextButton
      class="btn ghost settings-back-button"
      data-settings-target="settings"
    >
      <ArrowBackIcon slot="icon" />
      Settings
    </MdTextButton>
    <header class="pels-hero">
      <div>
        <p class="eyebrow">Electricity prices</p>
        <h2>Source and rules</h2>
        <p class="muted electricity-prices-hero__lede">
          Choose where prices come from and what counts as cheap or expensive. PELS uses these to shape the daily budget toward cheaper hours.
        </p>
      </div>
    </header>
  </>
);

const StatusRow = ({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) => (
  <div class="price-config-status-row">
    <span class="price-config-status-label">{label}</span>
    <span class={['price-config-status-value', tone].filter(Boolean).join(' ')}>{value}</span>
  </div>
);

const FlowStatusBlock = ({ status }: { status: FlowStatus }) => (
  <div class="price-config-source-status">
    <StatusRow label="Power by the Hour" value="Enabled" tone="ok" />
    <StatusRow label="Today" value={status.today.text} tone={status.today.tone} />
    <StatusRow label="Tomorrow" value={status.tomorrow.text} tone={status.tomorrow.tone} />
  </div>
);

const HomeyStatusBlock = ({ status }: { status: HomeyStatus }) => (
  <div class="price-config-source-status">
    <StatusRow label="Homey Energy" value="Enabled" tone="ok" />
    <StatusRow label="Currency" value={status.currency} tone={status.currencyTone} />
    <StatusRow label="Today" value={status.today.text} tone={status.today.tone} />
    <StatusRow label="Tomorrow" value={status.tomorrow.text} tone={status.tomorrow.tone} />
  </div>
);

const schemeNote = (scheme: PriceScheme): string | null => {
  if (scheme === 'norway') {
    return 'Norway combines spot prices, grid tariff, provider surcharge, '
      + 'taxes, and electricity support into a single total price.';
  }
  if (scheme === 'flow') {
    return 'Flow source uses values as provided (currency/tax may vary). '
      + 'Use this outside Norway or when you prefer external prices. '
      + 'Feed today and tomorrow prices via PELS flow actions.';
  }
  if (scheme === 'homey') {
    return 'Homey Energy uses values as provided (currency/tax may vary). '
      + 'Prices are read from your Homey Energy settings and used directly.';
  }
  return null;
};

const NorwaySection = ({
  norwayPriceModel,
  priceArea,
  providerSurcharge,
  countyCode,
  organizationNumber,
  tariffGroup,
  gridCompanyOptions,
  onNorwayModelChange,
  onPriceAreaChange,
  onProviderSurchargeChange,
  onCountyChange,
  onOrganizationChange,
  onTariffGroupChange,
  onRefreshGridTariff,
}: {
  norwayPriceModel: NorwayPriceModel;
  priceArea: string;
  providerSurcharge: number;
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
  gridCompanyOptions: GridCompanyOption[];
  onNorwayModelChange: (m: NorwayPriceModel) => void;
  onPriceAreaChange: (a: string) => void;
  onProviderSurchargeChange: (v: number) => void;
  onCountyChange: (c: string) => void;
  onOrganizationChange: (o: string) => void;
  onTariffGroupChange: (g: string) => void;
  onRefreshGridTariff: () => void;
}) => (
  <>
    <p class="eyebrow eyebrow--inline">Grid tariff</p>
    <div class="field">
      <span class="field__label" id="electricity-prices-county-label">County</span>
      <MdFilledSelect
        value={countyCode}
        aria-labelledby="electricity-prices-county-label"
        onChange={(e) => onCountyChange(readValue(e))}
      >
        <MdSelectOption value="03"><div slot="headline">Oslo</div></MdSelectOption>
        <MdSelectOption value="11"><div slot="headline">Rogaland</div></MdSelectOption>
        <MdSelectOption value="15"><div slot="headline">Møre og Romsdal</div></MdSelectOption>
        <MdSelectOption value="18"><div slot="headline">Nordland</div></MdSelectOption>
        <MdSelectOption value="31"><div slot="headline">Østfold</div></MdSelectOption>
        <MdSelectOption value="32"><div slot="headline">Akershus</div></MdSelectOption>
        <MdSelectOption value="33"><div slot="headline">Buskerud</div></MdSelectOption>
        <MdSelectOption value="34"><div slot="headline">Innlandet</div></MdSelectOption>
        <MdSelectOption value="39"><div slot="headline">Vestfold</div></MdSelectOption>
        <MdSelectOption value="40"><div slot="headline">Telemark</div></MdSelectOption>
        <MdSelectOption value="42"><div slot="headline">Agder</div></MdSelectOption>
        <MdSelectOption value="46"><div slot="headline">Vestland</div></MdSelectOption>
        <MdSelectOption value="50"><div slot="headline">Trøndelag</div></MdSelectOption>
        <MdSelectOption value="55"><div slot="headline">Troms</div></MdSelectOption>
        <MdSelectOption value="56"><div slot="headline">Finnmark</div></MdSelectOption>
      </MdFilledSelect>
      <small class="field__hint">Your county for grid tariff lookup.</small>
    </div>
    <div class="field">
      <span class="field__label" id="electricity-prices-grid-company-label">Grid company</span>
      <MdFilledSelect
        value={organizationNumber}
        aria-labelledby="electricity-prices-grid-company-label"
        onChange={(e) => onOrganizationChange(readValue(e))}
      >
        <MdSelectOption value=""><div slot="headline">Select grid company</div></MdSelectOption>
        {gridCompanyOptions.map((c) => (
          <MdSelectOption key={c.organizationNumber} value={c.organizationNumber}>
            <div slot="headline">{c.name}</div>
          </MdSelectOption>
        ))}
      </MdFilledSelect>
      <small class="field__hint">Filtered by county.</small>
    </div>
    <div class="field">
      <span class="field__label" id="electricity-prices-tariff-group-label">Tariff group</span>
      <MdFilledSelect
        value={tariffGroup}
        aria-labelledby="electricity-prices-tariff-group-label"
        onChange={(e) => onTariffGroupChange(readValue(e))}
      >
        <MdSelectOption value="Husholdning"><div slot="headline">Household</div></MdSelectOption>
        <MdSelectOption value="Hytter og fritidshus">
          <div slot="headline">Cabin and holiday home</div>
        </MdSelectOption>
      </MdFilledSelect>
    </div>
    <div class="form__actions">
      <MdOutlinedButton type="button" class="btn ghost" onClick={onRefreshGridTariff}>
        Refresh tariffs
      </MdOutlinedButton>
    </div>

    <p class="eyebrow eyebrow--inline">Spot price</p>
    <div class="field">
      <span class="field__label" id="electricity-prices-norway-model-label">Norway pricing model</span>
      <MdFilledSelect
        value={norwayPriceModel}
        aria-labelledby="electricity-prices-norway-model-label"
        onChange={(e) => onNorwayModelChange(readValue(e) as NorwayPriceModel)}
      >
        <MdSelectOption value="stromstotte">
          <div slot="headline">Electricity Subsidy Scheme (Strømstøtte)</div>
        </MdSelectOption>
        <MdSelectOption value="norgespris">
          <div slot="headline">Norway Price (Norgespris)</div>
        </MdSelectOption>
      </MdFilledSelect>
      <small class="field__hint">
        Choose whether Norway prices use the Electricity Subsidy Scheme or Norway Price (Norgespris).
      </small>
    </div>
    {norwayPriceModel === 'norgespris' && (
      <p class="muted">
        Official Norgespris rules are applied automatically: fixed spot target 50 øre/kWh incl. VAT.
        Monthly cap: household 5000 kWh, cabin 1000 kWh.
      </p>
    )}
    <div class="field">
      <span class="field__label" id="electricity-prices-price-area-label">Price area</span>
      <MdFilledSelect
        value={priceArea}
        aria-labelledby="electricity-prices-price-area-label"
        onChange={(e) => onPriceAreaChange(readValue(e))}
      >
        <MdSelectOption value="NO1"><div slot="headline">NO1 — Oslo / East Norway</div></MdSelectOption>
        <MdSelectOption value="NO2"><div slot="headline">NO2 — Kristiansand / South Norway</div></MdSelectOption>
        <MdSelectOption value="NO3"><div slot="headline">NO3 — Trondheim / Central Norway</div></MdSelectOption>
        <MdSelectOption value="NO4"><div slot="headline">NO4 — Tromsø / North Norway (no VAT)</div></MdSelectOption>
        <MdSelectOption value="NO5"><div slot="headline">NO5 — Bergen / West Norway</div></MdSelectOption>
      </MdFilledSelect>
      <small class="field__hint">
        {'Your electricity price area ('}
        <a href="https://www.hvakosterstrommen.no/" target="_blank" rel="noopener noreferrer">hvakosterstrommen.no</a>
        {').'}
      </small>
    </div>
    <label class="field">
      <span class="field__label" id="electricity-prices-provider-surcharge-label">Provider surcharge (øre/kWh, incl. VAT)</span>
      <MdFilledTextField
        type="number"
        value={String(providerSurcharge)}
        step="0.1"
        min="-100"
        max="100"
        aria-labelledby="electricity-prices-provider-surcharge-label"
        onChange={(e) => {
          const val = readFiniteNumber(e);
          if (val !== null) onProviderSurchargeChange(val);
        }}
      />
      <small class="field__hint">Provider surcharge on top of spot price, incl. VAT. Can be negative.</small>
    </label>
  </>
);

const SourceForm = (props: ElectricityPricesViewProps) => {
  const note = schemeNote(props.priceScheme);
  const isNorway = props.priceScheme === 'norway';
  const isFlow = props.priceScheme === 'flow';
  const isHomey = props.priceScheme === 'homey';

  return (
    <form class="form-grid settings-form-card" onSubmit={(e) => e.preventDefault()}>
      <h3 class="section-title">Price source</h3>
      <div class="field">
        <MdFilledSelect
          id="price-source-select"
          aria-label="Price source"
          value={props.priceScheme}
          onChange={(e) => props.onSchemeChange(readValue(e) as PriceScheme)}
        >
          <MdSelectOption value="norway">
            <div slot="headline">Norway (spot + grid tariff)</div>
          </MdSelectOption>
          <MdSelectOption value="flow">
            <div slot="headline">Flow (Power by the Hour)</div>
          </MdSelectOption>
          <MdSelectOption value="homey">
            <div slot="headline">Homey Energy (dynamic prices)</div>
          </MdSelectOption>
        </MdFilledSelect>
        <small class="field__hint">Where PELS fetches price data.</small>
      </div>

      {note && <p class="muted">{note}</p>}
      {isFlow && props.flowStatus && <FlowStatusBlock status={props.flowStatus} />}
      {isHomey && props.homeyStatus && <HomeyStatusBlock status={props.homeyStatus} />}

      {isNorway && (
        <NorwaySection
          norwayPriceModel={props.norwayPriceModel}
          priceArea={props.priceArea}
          providerSurcharge={props.providerSurcharge}
          countyCode={props.countyCode}
          organizationNumber={props.organizationNumber}
          tariffGroup={props.tariffGroup}
          gridCompanyOptions={props.gridCompanyOptions}
          onNorwayModelChange={props.onNorwayModelChange}
          onPriceAreaChange={props.onPriceAreaChange}
          onProviderSurchargeChange={props.onProviderSurchargeChange}
          onCountyChange={props.onCountyChange}
          onOrganizationChange={props.onOrganizationChange}
          onTariffGroupChange={props.onTariffGroupChange}
          onRefreshGridTariff={props.onRefreshGridTariff}
        />
      )}

      {!isFlow && (
        <div class="form__actions">
          <MdOutlinedButton type="button" class="btn ghost" onClick={props.onRefreshPrices}>
            Refresh prices
          </MdOutlinedButton>
        </div>
      )}
    </form>
  );
};

const ThresholdForm = ({
  thresholdPercent,
  minDiffOre,
  isExternal,
  onThresholdChange,
  onMinDiffChange,
}: {
  thresholdPercent: number;
  minDiffOre: number;
  isExternal: boolean;
  onThresholdChange: (val: number) => void;
  onMinDiffChange: (val: number) => void;
}) => (
  <form class="form-grid settings-form-card" onSubmit={(e) => e.preventDefault()}>
    <h3 class="section-title">Cheap and expensive hours</h3>
    <p class="muted">Defines what counts as cheap or expensive.</p>
    <label class="field">
      <span class="field__label" id="electricity-prices-threshold-label">Price threshold (%)</span>
      <MdFilledTextField
        type="number"
        value={String(thresholdPercent)}
        min="5"
        max="50"
        step="1"
        aria-labelledby="electricity-prices-threshold-label"
        onChange={(e) => {
          const val = readFiniteNumber(e);
          if (val !== null) onThresholdChange(val);
        }}
      />
      <small class="field__hint">Hours this % below or above average are marked cheap or expensive.</small>
    </label>
    <label class="field">
      <span class="field__label" id="electricity-prices-min-diff-label">
        {isExternal ? 'Minimum price difference' : 'Minimum price difference (øre/kWh)'}
      </span>
      <MdFilledTextField
        type="number"
        value={String(minDiffOre)}
        min="0"
        max="1000"
        step="any"
        inputmode="decimal"
        aria-labelledby="electricity-prices-min-diff-label"
        onChange={(e) => {
          const val = readFiniteNumber(e);
          if (val !== null) onMinDiffChange(val);
        }}
      />
      <small class="field__hint">Skip optimization if savings are less than this.</small>
    </label>
  </form>
);

const PriceAwareDevicesLink = () => (
  <div class="form__actions">
    <MdOutlinedButton class="btn ghost" data-settings-target="price-aware-devices">
      Manage price-aware devices →
    </MdOutlinedButton>
  </div>
);

const ElectricityPricesRoot = (props: ElectricityPricesViewProps) => {
  const isExternal = props.priceScheme === 'flow' || props.priceScheme === 'homey';

  return (
    <>
      <Header />
      <SourceForm {...props} />
      <ThresholdForm
        thresholdPercent={props.thresholdPercent}
        minDiffOre={props.minDiffOre}
        isExternal={isExternal}
        onThresholdChange={props.onThresholdChange}
        onMinDiffChange={props.onMinDiffChange}
      />
      {props.showPriceAwareDevicesLink && <PriceAwareDevicesLink />}
    </>
  );
};

export const renderElectricityPricesView = (
  surface: HTMLElement,
  props: ElectricityPricesViewProps,
): void => {
  render(<ElectricityPricesRoot {...props} />, surface);
};
