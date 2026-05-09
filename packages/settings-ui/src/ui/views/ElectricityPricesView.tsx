import { render } from 'preact';
import type {
  PriceScheme,
  NorwayPriceModel,
  FlowStatus,
  HomeyStatus,
  GridCompanyOption,
} from '../priceConfigTypes.ts';

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
    <button
      type="button"
      class="btn ghost settings-back-button"
      data-settings-target="settings"
    >
      ‹ Settings
    </button>
    <div class="card__header">
      <div>
        <p class="eyebrow">Electricity prices</p>
        <h2>Source and rules</h2>
      </div>
    </div>
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
    <label class="field">
      <span class="field__label">County</span>
      <select
        value={countyCode}
        onChange={(e) => onCountyChange((e.target as HTMLSelectElement).value)}
      >
        <option value="03">Oslo</option>
        <option value="11">Rogaland</option>
        <option value="15">Møre og Romsdal</option>
        <option value="18">Nordland</option>
        <option value="31">Østfold</option>
        <option value="32">Akershus</option>
        <option value="33">Buskerud</option>
        <option value="34">Innlandet</option>
        <option value="39">Vestfold</option>
        <option value="40">Telemark</option>
        <option value="42">Agder</option>
        <option value="46">Vestland</option>
        <option value="50">Trøndelag</option>
        <option value="55">Troms</option>
        <option value="56">Finnmark</option>
      </select>
      <small class="field__hint">Your county for grid tariff lookup.</small>
    </label>
    <label class="field">
      <span class="field__label">Grid company</span>
      <select
        value={organizationNumber}
        onChange={(e) => onOrganizationChange((e.target as HTMLSelectElement).value)}
      >
        <option value="">-- Select grid company --</option>
        {gridCompanyOptions.map((c) => (
          <option key={c.organizationNumber} value={c.organizationNumber}>{c.name}</option>
        ))}
      </select>
      <small class="field__hint">Filtered by county.</small>
    </label>
    <label class="field">
      <span class="field__label">Tariff group</span>
      <select
        value={tariffGroup}
        onChange={(e) => onTariffGroupChange((e.target as HTMLSelectElement).value)}
      >
        <option value="Husholdning">Household</option>
        <option value="Hytter og fritidshus">Cabin and holiday home</option>
      </select>
    </label>
    <div class="form__actions">
      <button type="button" class="btn ghost" onClick={onRefreshGridTariff}>
        Refresh tariffs
      </button>
    </div>

    <p class="eyebrow eyebrow--inline">Spot price</p>
    <label class="field">
      <span class="field__label">Norway pricing model</span>
      <select
        value={norwayPriceModel}
        onChange={(e) => onNorwayModelChange((e.target as HTMLSelectElement).value as NorwayPriceModel)}
      >
        <option value="stromstotte">Electricity Subsidy Scheme (Strømstøtte)</option>
        <option value="norgespris">Norway Price (Norgespris)</option>
      </select>
      <small class="field__hint">
        Choose whether Norway prices use the Electricity Subsidy Scheme or Norway Price (Norgespris).
      </small>
    </label>
    {norwayPriceModel === 'norgespris' && (
      <p class="muted">
        Official Norgespris rules are applied automatically: fixed spot target 50 øre/kWh incl. VAT.
        Monthly cap: household 5000 kWh, cabin 1000 kWh.
      </p>
    )}
    <label class="field">
      <span class="field__label">Price area</span>
      <select
        value={priceArea}
        onChange={(e) => onPriceAreaChange((e.target as HTMLSelectElement).value)}
      >
        <option value="NO1">NO1 — Oslo / East Norway</option>
        <option value="NO2">NO2 — Kristiansand / South Norway</option>
        <option value="NO3">NO3 — Trondheim / Central Norway</option>
        <option value="NO4">NO4 — Tromsø / North Norway (no VAT)</option>
        <option value="NO5">NO5 — Bergen / West Norway</option>
      </select>
      <small class="field__hint">Your electricity price area (hvakosterstrommen.no).</small>
    </label>
    <label class="field">
      <span class="field__label">Provider surcharge (øre/kWh, incl. VAT)</span>
      <input
        type="number"
        value={String(providerSurcharge)}
        step="0.1"
        min="-100"
        max="100"
        onChange={(e) => {
          const val = Number.parseFloat((e.target as HTMLInputElement).value);
          if (Number.isFinite(val)) onProviderSurchargeChange(val);
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
      <label class="field">
        <select
          aria-label="Price source"
          value={props.priceScheme}
          onChange={(e) => props.onSchemeChange((e.target as HTMLSelectElement).value as PriceScheme)}
        >
          <option value="norway">Norway (spot + grid tariff)</option>
          <option value="flow">Flow (Power by the Hour)</option>
          <option value="homey">Homey Energy (dynamic prices)</option>
        </select>
        <small class="field__hint">Where PELS fetches price data.</small>
      </label>

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
          <button type="button" class="btn ghost" onClick={props.onRefreshPrices}>
            Refresh prices
          </button>
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
      <span class="field__label">Price threshold (%)</span>
      <input
        type="number"
        value={String(thresholdPercent)}
        min="5"
        max="50"
        step="1"
        onChange={(e) => {
          const val = Number.parseFloat((e.target as HTMLInputElement).value);
          if (Number.isFinite(val)) onThresholdChange(val);
        }}
      />
      <small class="field__hint">Hours this % below or above average are marked cheap or expensive.</small>
    </label>
    <label class="field">
      <span class="field__label">
        {isExternal ? 'Minimum price difference' : 'Minimum price difference (øre/kWh)'}
      </span>
      <input
        type="number"
        value={String(minDiffOre)}
        min="0"
        max="1000"
        step="any"
        inputmode="decimal"
        onChange={(e) => {
          const val = Number.parseFloat((e.target as HTMLInputElement).value);
          if (Number.isFinite(val)) onMinDiffChange(val);
        }}
      />
      <small class="field__hint">Skip optimization if savings are less than this.</small>
    </label>
  </form>
);

const PriceAwareDevicesLink = () => (
  <div class="form__actions">
    <button type="button" class="btn ghost" data-settings-target="price-aware-devices">
      Manage price-aware devices →
    </button>
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
