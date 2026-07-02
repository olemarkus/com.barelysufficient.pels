import { render } from 'preact';
import type {
  PriceScheme,
  NorwayPriceModel,
  FlowStatus,
  HomeyStatus,
  GridCompanyOption,
} from '../priceConfigTypes.ts';
import { resolvePriceLevelChip } from '../../../../shared-domain/src/priceLevelChips.ts';
import {
  MdFilledSelect,
  MdFilledTextField,
  MdOutlinedButton,
  MdSelectOption,
  MdSwitch,
  MdTextButton,
} from './materialWebJSX.tsx';
import { ArrowBackIcon } from './icons.tsx';
import {
  EXPORT_FIXED_LIMIT,
  EXPORT_SPOT_FACTOR_MAX,
  EXPORT_SPOT_FACTOR_MIN,
} from '../exportPriceSettings.ts';

type ValueElement = HTMLElement & { value: string };
type SwitchElement = HTMLElement & { selected: boolean };

const readValue = (event: Event): string => (event.currentTarget as ValueElement).value;

// md-select treats an empty `value` as "no selection" and renders nothing in the
// closed field (Material expects a floating label to fill that space, but PELS
// renders the field label outside the control) — so a `value=""` placeholder
// option shows a blank box. Routing the "nothing chosen" state through a
// non-empty sentinel makes md-select display the placeholder option's text the
// same way it does for every real option. The sentinel never leaves this view:
// it is mapped back to `''` on change and from `''` on render.
const GRID_COMPANY_NONE = '__none__';

const readFiniteNumber = (event: Event): number | null => {
  const value = Number.parseFloat(readValue(event));
  return Number.isFinite(value) ? value : null;
};

export type ElectricityPricesViewProps = {
  thresholdPercent: number;
  minDiffOre: number;
  priceScheme: PriceScheme;
  // Live price signals for the summary card. `currentPriceLevel` is the raw
  // free-form Homey level (cheap / normal / expensive / null) — fed through the
  // canonical `resolvePriceLevelChip` helper so the wording matches the budget
  // hero and runtime logs. `lastFetchedShort` is a pre-formatted short clock
  // time (or null when prices have not been fetched yet).
  currentPriceLevel: string | null;
  lastFetchedShort: string | null;
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
  // Export (feed-in) price section. Prosumer-gated by the orchestrator: shown
  // when the home has a managed solar device OR export pricing is already on
  // (never strand an enabled user behind the gate).
  showExportSection: boolean;
  exportPriceEnabled: boolean;
  exportSpotFactor: number;
  exportFixed: number;
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
  onExportEnabledChange: (enabled: boolean) => void;
  // Numeric export handlers also receive the field element so a rejected or
  // unsaved value can be snapped back to the stored one (see ExportPriceForm).
  onExportSpotFactorChange: (val: number, field: { value: string }) => void;
  onExportFixedChange: (val: number, field: { value: string }) => void;
};

const Header = () => (
  <>
    <MdTextButton
      class="settings-back-button"
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

// Compact live summary of the current price signal at the top of the panel.
// The tier chip reuses the canonical `resolvePriceLevelChip` pair ("Price low"
// / "Price high") so it never disagrees with the budget hero or the runtime
// logs; `normal` / unknown levels return null, in which case we carry the calm
// state as toned text rather than inventing a third chip (the M3 chip rail
// stays quiet when there is nothing exceptional to say).
const LiveSummaryCard = ({
  currentPriceLevel,
  lastFetchedShort,
}: {
  currentPriceLevel: string | null;
  lastFetchedShort: string | null;
}) => {
  const chip = resolvePriceLevelChip(currentPriceLevel);
  const chipToneCls = chip ? (chip.tone === 'warn' ? 'plan-chip--warn' : 'plan-chip--info') : '';
  // No chip → calm wording. Only the recognised, actionable-but-quiet level
  // ("normal") earns "Normal"; "unknown" / null / anything else means prices
  // have not arrived yet, so we say so rather than implying an all-clear.
  const calmValue = currentPriceLevel === 'normal' ? 'Normal' : 'Awaiting prices';
  // A usable current price means there are prices covering this hour (a chip or
  // the "normal" level). When we're still "Awaiting prices" the last-fetched
  // timestamp refers to a fetch that does not cover now, so showing it next to
  // "Awaiting prices" reads as a contradiction ("fetched at 06:31" yet "no
  // price"). Suppress the row until a current price exists.
  const hasUsablePriceLevel = chip !== null || currentPriceLevel === 'normal';
  return (
    <section class="settings-form-card electricity-prices-live-summary">
      <h3 class="section-title">Right now</h3>
      <div class="price-config-status-row">
        <span class="price-config-status-label">Current price</span>
        {chip ? (
          <span class={`plan-chip ${chipToneCls}`} data-price-level={chip.priceLevel}>
            {chip.label}
          </span>
        ) : (
          <span class="price-config-status-value">{calmValue}</span>
        )}
      </div>
      {hasUsablePriceLevel ? (
        <StatusRow label="Last fetched" value={lastFetchedShort ?? '—'} />
      ) : null}
    </section>
  );
};

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
      <span class="field__label pels-text-settings-label" id="electricity-prices-county-label">County</span>
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
      <span class="field__label pels-text-settings-label" id="electricity-prices-grid-company-label">Grid company</span>
      <MdFilledSelect
        value={organizationNumber || GRID_COMPANY_NONE}
        aria-labelledby="electricity-prices-grid-company-label"
        onChange={(e) => {
          const next = readValue(e);
          onOrganizationChange(next === GRID_COMPANY_NONE ? '' : next);
        }}
      >
        <MdSelectOption value={GRID_COMPANY_NONE}><div slot="headline">Select grid company</div></MdSelectOption>
        {gridCompanyOptions.map((c) => (
          <MdSelectOption key={c.organizationNumber} value={c.organizationNumber}>
            <div slot="headline">{c.name}</div>
          </MdSelectOption>
        ))}
      </MdFilledSelect>
      <small class="field__hint">Filtered by county.</small>
    </div>
    <div class="field">
      <span class="field__label pels-text-settings-label" id="electricity-prices-tariff-group-label">Tariff group</span>
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
      <MdOutlinedButton type="button" onClick={onRefreshGridTariff}>
        Refresh tariffs
      </MdOutlinedButton>
    </div>

    <p class="eyebrow eyebrow--inline">Spot price</p>
    <div class="field">
      <span class="field__label pels-text-settings-label" id="electricity-prices-norway-model-label">Norway pricing model</span>
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
      <span class="field__label pels-text-settings-label" id="electricity-prices-price-area-label">Price area</span>
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
      <span class="field__label pels-text-settings-label" id="electricity-prices-provider-surcharge-label">Provider surcharge (øre/kWh, incl. VAT)</span>
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
          <MdOutlinedButton type="button" onClick={props.onRefreshPrices}>
            Refresh prices
          </MdOutlinedButton>
        </div>
      )}
    </form>
  );
};

// Spot-share hint, three-way:
//   • Norway: the percentage multiplies the VAT-INCLUSIVE spot (the same
//     grossed spot the import price uses — lib/price/exportPrice.ts), but
//     contracts typically quote a share of the raw ex-VAT spot. State the
//     basis and give the conversion recipe: 100% of raw spot = 100 / 1.25 =
//     80% of the incl-VAT spot.
//   • Spot-less scheme with a stored non-zero share: nothing applies until
//     the share is 0 — name the repair.
//   • Spot-less scheme, share settled at 0: the fixed amount is the whole
//     export price.
const spotShareHint = (hasSpotPrice: boolean, staleSpotShare: boolean): string => {
  if (hasSpotPrice) {
    return 'Share of the hourly spot price (incl. VAT) you’re paid per exported kWh. '
      + 'If your contract pays the raw spot price, enter 80. 0 means the fixed amount only.';
  }
  if (staleSpotShare) {
    return 'Needs a spot price, which only the Norway price source provides. '
      + 'Set the share to 0 to use the fixed amount only.';
  }
  return 'Needs a spot price, which only the Norway price source provides. Only the fixed amount applies.';
};

// Export (feed-in) price — a distinct section, deliberately separate from the
// import-price config above it: the export price is built from the wholesale
// spot plus the user's feed-in contract terms, never from the import price
// (`lib/price/exportPrice.ts`). Labels follow `notes/ui-terminology.md`
// § "Solar and export price vocabulary".
const ExportPriceForm = ({
  priceScheme,
  exportPriceEnabled,
  exportSpotFactor,
  exportFixed,
  onExportEnabledChange,
  onExportSpotFactorChange,
  onExportFixedChange,
}: {
  priceScheme: PriceScheme;
  exportPriceEnabled: boolean;
  exportSpotFactor: number;
  exportFixed: number;
  onExportEnabledChange: (enabled: boolean) => void;
  onExportSpotFactorChange: (val: number, field: { value: string }) => void;
  onExportFixedChange: (val: number, field: { value: string }) => void;
}) => {
  // A spot-linked share is only meaningful where an hourly spot price is
  // isolatable, which only the Norway source provides. On the flow / Homey
  // sources a share settled at 0 renders disabled with the fixed-only note.
  // A stored NON-ZERO share there (CLI-configured, or a failed normalization
  // write) yields NO export price at all (lib/price/exportPrice.ts) — never
  // mask it as a working 0: surface the real value, keep the field editable,
  // and tell the user the repair (set it to 0 — an explicit user write).
  const hasSpotPrice = priceScheme === 'norway';
  const staleSpotShare = !hasSpotPrice && exportSpotFactor !== 0;
  const shareEditable = hasSpotPrice || staleSpotShare;
  return (
    <form
      id="electricity-prices-export-section"
      class="form-grid settings-form-card"
      onSubmit={(e) => e.preventDefault()}
    >
      <h3 class="section-title">Export price</h3>
      <p class="muted">
        What you’re paid for power you send to the grid — check what your power company pays you.
        The Budget tab shows the current export price while this is on.
      </p>
      <div class="field checkbox-field">
        <MdSwitch
          id="electricity-prices-export-enabled"
          aria-label="Use an export price"
          {...(exportPriceEnabled ? { selected: true } : {})}
          onChange={(e) => onExportEnabledChange((e.currentTarget as SwitchElement).selected)}
        />
        <span class="checkbox-field__content">
          <span class="field__label pels-text-settings-label">Use an export price</span>
        </span>
      </div>
      {exportPriceEnabled && (
        <>
          <label class="field">
            <span class="field__label pels-text-settings-label" id="electricity-prices-export-spot-factor-label">
              Share of spot price (%)
            </span>
            <MdFilledTextField
              id="electricity-prices-export-spot-factor"
              type="number"
              value={String(exportSpotFactor)}
              min={String(EXPORT_SPOT_FACTOR_MIN)}
              max={String(EXPORT_SPOT_FACTOR_MAX)}
              step="1"
              inputmode="decimal"
              {...(shareEditable ? {} : { disabled: true })}
              aria-labelledby="electricity-prices-export-spot-factor-label"
              onChange={(e) => {
                const val = readFiniteNumber(e);
                // Pass the element so a rejected value can be snapped back:
                // Preact's retained VDOM won't rewrite a value prop that
                // didn't change, so the handler resets it imperatively.
                if (val !== null) onExportSpotFactorChange(val, e.currentTarget as ValueElement);
              }}
            />
            <small class="field__hint">
              {spotShareHint(hasSpotPrice, staleSpotShare)}
            </small>
          </label>
          <label class="field">
            <span class="field__label pels-text-settings-label" id="electricity-prices-export-fixed-label">
              {hasSpotPrice ? 'Fixed amount (øre/kWh, incl. VAT)' : 'Fixed amount'}
            </span>
            <MdFilledTextField
              id="electricity-prices-export-fixed"
              type="number"
              value={String(exportFixed)}
              min={String(-EXPORT_FIXED_LIMIT)}
              max={String(EXPORT_FIXED_LIMIT)}
              step="0.1"
              inputmode="decimal"
              aria-labelledby="electricity-prices-export-fixed-label"
              onChange={(e) => {
                const val = readFiniteNumber(e);
                // Same snap-back contract as the spot-share field above.
                if (val !== null) onExportFixedChange(val, e.currentTarget as ValueElement);
              }}
            />
            <small class="field__hint">
              {hasSpotPrice
                ? 'Added for every exported kWh. Negative means you pay to export.'
                : 'Added for every exported kWh, in the same unit as your prices. Negative means you pay to export.'}
            </small>
          </label>
        </>
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
      <span class="field__label pels-text-settings-label" id="electricity-prices-threshold-label">Price threshold (%)</span>
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
      <span class="field__label pels-text-settings-label" id="electricity-prices-min-diff-label">
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
    <MdOutlinedButton data-settings-target="price-aware-devices">
      Manage price-aware devices →
    </MdOutlinedButton>
  </div>
);

const ElectricityPricesRoot = (props: ElectricityPricesViewProps) => {
  const isExternal = props.priceScheme === 'flow' || props.priceScheme === 'homey';

  return (
    <>
      <Header />
      <LiveSummaryCard
        currentPriceLevel={props.currentPriceLevel}
        lastFetchedShort={props.lastFetchedShort}
      />
      <SourceForm {...props} />
      {props.showExportSection && (
        <ExportPriceForm
          priceScheme={props.priceScheme}
          exportPriceEnabled={props.exportPriceEnabled}
          exportSpotFactor={props.exportSpotFactor}
          exportFixed={props.exportFixed}
          onExportEnabledChange={props.onExportEnabledChange}
          onExportSpotFactorChange={props.onExportSpotFactorChange}
          onExportFixedChange={props.onExportFixedChange}
        />
      )}
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
