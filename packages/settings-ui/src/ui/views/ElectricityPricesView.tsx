import { render, type ComponentChildren } from 'preact';
import type {
  PriceConfigState,
  PriceScheme,
  NorwayPriceModel,
  FlowStatus,
  HomeyStatus,
  PowerhourStatus,
  StatusValue,
  GridCompanyOption,
  PvForecastSourceSetting,
} from '../priceConfigTypes.ts';
import { normalizeNorwayPriceModel, normalizePriceSchemeSelection } from '../priceSettingsPersistence.ts';
import type {
  PowerhourDeviceUiOption,
  PowerhourSourceUiStatus,
} from '../../../../contracts/src/settingsUiApi.ts';
import { resolvePriceLevelChip } from '../../../../shared-domain/src/priceLevelChips.ts';
import { resolvePvForecastStatusLine } from '../../../../shared-domain/src/solar/pvForecastSourceStatus.ts';
import { isPvForecastSourceSetting } from '../../../../shared-domain/src/settings/pvForecastSource.ts';
import { EXPORT_PRICE_LABEL } from '../../../../shared-domain/src/price/planningPrice.ts';
import {
  MdFilledSelect,
  MdFilledTextField,
  MdOutlinedButton,
  MdSelectOption,
  MdSwitch,
} from './materialWebJSX.tsx';
import { AppBar } from './AppBar.tsx';
import {
  NORWAY_PRICE_MODEL_NAMES,
  type NorwayChoices,
  type PriceSourceAssumption,
} from '../priceSetupStatus.ts';
import {
  EXPORT_FIXED_LIMIT,
  EXPORT_SPOT_FACTOR_MAX,
  EXPORT_SPOT_FACTOR_MIN,
} from '../exportPriceSettings.ts';
import type { ExportPriceSourceSetting } from '../../../../shared-domain/src/settings/exportPriceSource.ts';

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
// The same for a pricing model or price area the owner never chose. Showing
// PELS's default in the field would leave nothing to pick for an owner whose
// answer IS the default: selecting the value already shown fires no change.
const NOT_CHOSEN = '__not_chosen__';

const readFiniteNumber = (event: Event): number | null => {
  const value = Number.parseFloat(readValue(event));
  return Number.isFinite(value) ? value : null;
};

/** The page's callbacks into its controller (`priceConfig.ts`), one per control. */
export type ElectricityPricesHandlers = {
  onSchemeChange: (scheme: PriceScheme) => void;
  /** Save the assumed source as the owner's choice. */
  onKeepSource: () => void;
  onPowerhourDeviceChange: (deviceId: string) => void;
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
  onPvForecastSourceChange: (source: PvForecastSourceSetting) => void;
  onExportEnabledChange: (enabled: boolean) => void;
  onExportSourceChange: (source: ExportPriceSourceSetting) => void;
  // Numeric export handlers also receive the field element so a rejected or
  // unsaved value can be snapped back to the stored one (see ExportPriceForm).
  onExportSpotFactorChange: (val: number, field: { value: string }) => void;
  onExportFixedChange: (val: number, field: { value: string }) => void;
};

export type ElectricityPricesViewProps = {
  config: PriceConfigState;
  handlers: ElectricityPricesHandlers;
  gridCompanyOptions: GridCompanyOption[];
  /** Whether PELS assumed the source the page shows, and why. */
  sourceAssumption: PriceSourceAssumption;
  /** Which Norway settings the owner chose, so the page never presents a default as theirs. */
  norwayChoices: NorwayChoices;
  // Export (feed-in) price section. Prosumer-gated by the orchestrator: shown
  // when the home has a managed solar device OR export pricing is already on
  // (never strand an enabled user behind the gate).
  showExportSection: boolean;
  // Solar forecast source section. Solar-gated like the export section, plus
  // shown whenever a non-default source is already stored (never strand it).
  showSolarForecastSection: boolean;
};

const Header = () => (
  <AppBar
    back={{ target: 'settings', label: 'Back to Settings' }}
    title="Electricity prices"
    lede="Choose where prices come from and what counts as cheap or expensive. PELS uses these to shape the daily budget toward cheaper hours."
  />
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
const LiveSummaryCard = ({ config }: { config: PriceConfigState }) => {
  const { currentPriceLevel, liveSummary } = config;
  // Gate the live export/planning signals on the CURRENT enabled setting, not
  // the cached prices: `combined_prices` keeps carrying exportPrice/budgetPrice
  // for up to an hour after the user turns export pricing off (the prices only
  // drop them on the next rebuild), and `onEnabledChange` repaints without
  // recomputing `liveSummary`. Reading the live flag here suppresses the export
  // row and the `using your solar` reason line the instant the toggle flips —
  // an enabled user is byte-identical.
  //
  // Current-hour export (feed-in) price, pre-formatted and scaled through the
  // CostDisplay divisor (e.g. `0.34 kr/kWh`), or null when no export price
  // covers this hour. A non-prosumer never has one, so the row never renders.
  const currentExportPriceText = config.exportPriceEnabled ? liveSummary.exportText : null;
  // The registered `using your solar` reason line, present only when the
  // current-hour planning price (which the "Current price" level tiers on
  // post-#1808) diverges from the import price. Null otherwise, so a
  // non-prosumer sees nothing new.
  const planningPriceReasonLine = config.exportPriceEnabled ? liveSummary.planningReasonLine : null;
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
      <div class="electricity-prices-current-price">
        {/* "Right now" is the row's own heading — the former separate
            "Current price" label doubled it, so it was dropped (legibility
            item: every caption must add information its label doesn't). */}
        <div class="price-config-status-row">
          <h3 class="section-title">Right now</h3>
          {chip ? (
            <span class={`plan-chip ${chipToneCls}`} data-price-level={chip.priceLevel}>
              {chip.label}
            </span>
          ) : (
            <span class="price-config-status-value">{calmValue}</span>
          )}
        </div>
        {/* Sub-note under the current-price row it explains: the level tiers on
            the planning price for a prosumer. Same grey (pels-card-supporting)
            as the Budget chart's note so the shared string reads as one voice. */}
        {planningPriceReasonLine !== null ? (
          <p class="pels-card-supporting electricity-prices-planning-reason">{planningPriceReasonLine}</p>
        ) : null}
      </div>
      {currentExportPriceText !== null ? (
        <StatusRow label={EXPORT_PRICE_LABEL} value={currentExportPriceText} />
      ) : null}
      {hasUsablePriceLevel ? (
        <StatusRow label="Last fetched" value={liveSummary.lastFetchedShort ?? '—'} />
      ) : null}
    </section>
  );
};

const FlowStatusBlock = ({ status }: { status: FlowStatus }) => (
  <div class="price-config-source-status">
    <StatusRow label="Flow prices" value="Enabled" tone="ok" />
    <StatusRow label="Today" value={status.today.text} tone={status.today.tone} />
    <StatusRow label="Tomorrow" value={status.tomorrow.text} tone={status.tomorrow.tone} />
  </div>
);

const HomeyStatusBlock = ({ status }: { status: HomeyStatus }) => (
  <div class="price-config-source-status">
    <StatusRow
      label="Homey Energy"
      value={status.hasPrices ? 'Prices found' : 'No prices'}
      tone={status.hasPrices ? 'ok' : 'warn'}
    />
    <StatusRow label="Currency" value={status.currency} tone={status.currencyTone} />
    <StatusRow label="Today" value={status.today.text} tone={status.today.tone} />
    <StatusRow label="Tomorrow" value={status.tomorrow.text} tone={status.tomorrow.tone} />
    {status.priceSetupIssue && (
      <>
        <StatusRow
          label="Price setup"
          value={status.priceSetupIssue.value.text}
          tone={status.priceSetupIssue.value.tone}
        />
        <p class="muted" id="electricity-prices-setup-issue">{status.priceSetupIssue.detail}</p>
      </>
    )}
  </div>
);

/**
 * How the owner reads one of the app's price devices: the name they gave it in
 * Power by the Hour, then how often it prices.
 *
 * Not the bidding zone. That field is the raw ENTSO-E code
 * (`10YNO-2--------T`) — the least readable string that could go on this page,
 * and at ~16 characters the one most likely to wrap the status row at 320 px.
 * The owner's own device name already says which zone it is, because Power by
 * the Hour names these devices after the zone.
 */
const powerhourDeviceLabel = (device: PowerhourDeviceUiOption): string => {
  const cadence = device.priceIntervalMinutes < 60
    ? `${device.priceIntervalMinutes}-minute prices`
    : 'hourly prices';
  return `${device.deviceName} (${cadence})`;
};

/**
 * The sentinel the "nothing chosen" row carries, for the same md-select reason
 * as `GRID_COMPANY_NONE`: an empty value renders a blank closed field.
 */
const POWERHOUR_DEVICE_NONE = '__none__';

type PowerhourDeviceSelectProps = {
  status: PowerhourSourceUiStatus;
  /**
   * The choice as the page has it, which is ahead of `status` for as long as
   * the runtime's own re-read of the app is in flight. Used only to keep the
   * field showing what the owner just picked; the resolved state is `status`.
   */
  pendingDeviceId: string | null;
  onChange: (deviceId: string) => void;
};

/**
 * The devices on offer, and whether the owner is being asked to choose between
 * them.
 *
 * One device is not a choice while the source is reading it — a select with a
 * single option is a question the owner cannot answer wrongly or usefully. It
 * IS a choice once the device they picked has gone: PELS will not adopt the
 * survivor on their behalf, so without the picker the source stays dead with no
 * way back (`powerhour_device_id` has no other writer).
 */
const powerhourPickerDevices = (status: PowerhourSourceUiStatus): PowerhourDeviceUiOption[] => {
  const devices = status.kind === 'reading' || status.kind === 'device_missing' ? status.devices : [];
  if (devices.length === 0) return [];
  return devices.length < 2 && status.kind !== 'device_missing' ? [] : devices;
};

const PowerhourDeviceSelect = ({
  status, pendingDeviceId, onChange,
}: PowerhourDeviceSelectProps) => {
  const devices = powerhourPickerDevices(status);
  if (devices.length === 0) return null;
  // md-select ignores a `value` no option carries and leaves the closed field
  // blank, so the id can only ever be used when an option actually holds it —
  // which is exactly what a stale stored id does not. The sentinel is the one
  // `GRID_COMPANY_NONE` exists for, and this is its second absent state:
  // chosen, but gone. A pending choice is shown so the field does not snap back
  // to the placeholder while the runtime is still re-reading the app.
  const pending = devices.some((device) => device.deviceId === pendingDeviceId)
    ? pendingDeviceId
    : null;
  const value = status.kind === 'reading'
    ? status.selected.deviceId
    : pending ?? POWERHOUR_DEVICE_NONE;
  return (
    <div class="field">
      <span class="field__label pels-text-settings-label">Price device</span>
      <MdFilledSelect
        id="powerhour-device-select"
        aria-label="Price device"
        value={value}
        onChange={(e) => {
          const selected = readValue(e);
          onChange(selected === POWERHOUR_DEVICE_NONE ? '' : selected);
        }}
      >
        {/* Only while nothing is in force: re-picking it once prices are flowing
            would silently stop the price source with no warning. */}
        {status.kind !== 'reading' && (
          <MdSelectOption value={POWERHOUR_DEVICE_NONE}>
            <div slot="headline">Choose a price device</div>
          </MdSelectOption>
        )}
        {devices.map((device) => (
          <MdSelectOption key={device.deviceId} value={device.deviceId}>
            <div slot="headline">{powerhourDeviceLabel(device)}</div>
          </MdSelectOption>
        ))}
      </MdFilledSelect>
      <small class="field__hint">
        PELS takes your prices from the device you pick here. The same zone paired twice
        works either way — the 15-minute one just follows prices four times an hour.
      </small>
    </div>
  );
};

/**
 * What the owner is told about the Power by the Hour source, and what they can
 * do about it. Each unavailable state names the place the fix is — which is
 * Homey or the other app, never this page.
 */
const powerhourSourceRow = (
  status: PowerhourSourceUiStatus,
): { value: StatusValue; detail: string | null } => {
  if (status.kind === 'reading') {
    return { value: { text: powerhourDeviceLabel(status.selected), tone: 'ok' }, detail: null };
  }
  if (status.kind === 'unknown') {
    return {
      value: { text: 'Not read yet', tone: 'warn' },
      detail: 'PELS hasn’t asked Power by the Hour for prices yet. It tries again '
        + 'every few hours — or press Refresh prices.',
    };
  }
  if (status.kind === 'not_permitted') {
    // Not "this needs a Homey Pro": PELS ships local-only, so it is never
    // installed anywhere app-to-app calls are unavailable. What is left is the
    // permission, which a PELS update grants.
    return {
      value: { text: 'No access to the app', tone: 'warn' },
      detail: 'Homey hasn’t given PELS access to Power by the Hour. Update PELS and '
        + 'allow the access it asks for.',
    };
  }
  if (status.kind === 'app_unavailable') {
    // Three causes reach this arm — the app is absent, it is not running, or it
    // answered with something PELS cannot read (an install older than the
    // version that added the route). PELS cannot tell them apart from here, so
    // the copy claims none of them and names the one place all three are fixed.
    return {
      value: { text: 'No prices from the app', tone: 'warn' },
      detail: 'PELS can’t read prices from Power by the Hour. Check in Homey that the '
        + 'app is installed, running and up to date, then press Refresh prices.',
    };
  }
  if (status.kind === 'no_devices') {
    return {
      value: { text: 'No price devices', tone: 'warn' },
      detail: 'Power by the Hour is running but has no electricity price device. '
        + 'Add one for your bidding zone in that app, then press Refresh prices.',
    };
  }
  // One arm, two different facts about the owner: they never chose, or the
  // device they DID choose has gone. Saying "No device chosen" to the second
  // contradicts the sentence directly under it.
  return status.deviceId
    ? {
      value: { text: 'Price device is gone', tone: 'warn' },
      detail: 'The price device PELS was using is gone from Power by the Hour. '
        + 'Pick another one below.',
    }
    : {
      value: { text: 'No device chosen', tone: 'warn' },
      detail: 'Power by the Hour has more than one price device. Pick the one '
        + 'that prices this home below.',
    };
};

type PowerhourStatusBlockProps = {
  status: PowerhourStatus;
  pendingDeviceId: string | null;
  onDeviceChange: (deviceId: string) => void;
};

const PowerhourStatusBlock = ({ status, pendingDeviceId, onDeviceChange }: PowerhourStatusBlockProps) => {
  const source = powerhourSourceRow(status.source);
  const hasPicker = powerhourPickerDevices(status.source).length > 0;
  return (
    <>
      <div class="price-config-source-status">
        {/* When the picker renders, its closed field already reads the device's
            name — two adjacent renderings of one long label is the doubling this
            page retired once already. Without a picker the row is the only place
            the device is named, so it names it. */}
        <StatusRow
          label="Price source"
          value={hasPicker && status.source.kind === 'reading' ? 'Reading prices' : source.value.text}
          tone={source.value.tone}
        />
        {source.detail && <p class="muted" id="electricity-prices-powerhour-issue">{source.detail}</p>}
        {/* Shown whenever days are STORED, not only while the source is reading:
            a failed read is a no-op, so PELS keeps planning against these
            prices, and hiding them would leave the owner unable to tell whether
            they have prices for tonight — the one thing this block is for. Each
            row carries its own "updated N min ago". */}
        {status.hasStoredDays && (
          <>
            <StatusRow label="Currency" value={status.currency} tone={status.currencyTone} />
            <StatusRow label="Today" value={status.today.text} tone={status.today.tone} />
            <StatusRow label="Tomorrow" value={status.tomorrow.text} tone={status.tomorrow.tone} />
          </>
        )}
      </div>
      {/* A form control, in the form grid where the page's other selects live —
          not wedged into the readout strip, whose 4px rhythm is for rows. */}
      <PowerhourDeviceSelect
        status={status.source}
        pendingDeviceId={pendingDeviceId}
        onChange={onDeviceChange}
      />
    </>
  );
};

const schemeNote = (scheme: PriceScheme, hasGridCompany: boolean): string | null => {
  if (scheme === 'norway') {
    // With no grid company PELS leaves the grid tariff out of every price, so
    // the note must not claim it is in.
    return hasGridCompany
      ? 'Norway combines spot prices, grid tariff, provider surcharge, '
        + 'taxes, and electricity support into a single total price.'
      : 'PELS adds up spot price, taxes, your provider surcharge and Strømstøtte or Norgespris, '
        + 'plus your grid tariff once you choose a grid company.';
  }
  if (scheme === 'flow') {
    return 'Flow source uses values as provided (currency/tax may vary). '
      + 'Use this outside Norway when your prices come from somewhere PELS has no '
      + 'source for; feed today and tomorrow prices via PELS flow actions. If they '
      + 'come from Power by the Hour, pick that source instead — it needs no flow.';
  }
  if (scheme === 'homey') {
    return 'Homey Energy uses values as provided (currency/tax may vary). '
      + 'Prices are read from your Homey Energy settings and used directly.';
  }
  if (scheme === 'powerhour') {
    return 'Power by the Hour supplies prices straight from that app, with the '
      + 'markups you set there (currency/tax may vary). No flow needed. Grid tariff '
      + 'is not included unless you added it there yourself.';
  }
  return null;
};

const COUNTIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '03', name: 'Oslo' },
  { code: '11', name: 'Rogaland' },
  { code: '15', name: 'Møre og Romsdal' },
  { code: '18', name: 'Nordland' },
  { code: '31', name: 'Østfold' },
  { code: '32', name: 'Akershus' },
  { code: '33', name: 'Buskerud' },
  { code: '34', name: 'Innlandet' },
  { code: '39', name: 'Vestfold' },
  { code: '40', name: 'Telemark' },
  { code: '42', name: 'Agder' },
  { code: '46', name: 'Vestland' },
  { code: '50', name: 'Trøndelag' },
  { code: '55', name: 'Troms' },
  { code: '56', name: 'Finnmark' },
];

/** What PELS prices with in place of a setting the owner never chose. */
const NotChosenHint = ({ text }: { text: string }) => (
  <small class="field__hint field__hint--alert">{text}</small>
);

const NorwaySection = ({ config, handlers, gridCompanyOptions, norwayChoices }: ElectricityPricesViewProps) => {
  // What PELS prices with in place of each setting the owner never chose.
  const choices = norwayChoices.kind === 'resolved' ? norwayChoices.choices : null;
  const assumedCounty = choices && !choices.county.chosen ? choices.county.value : null;
  const assumedModel = choices && !choices.pricingModel.chosen ? choices.pricingModel.value : null;
  const assumedArea = choices && !choices.priceArea.chosen ? choices.priceArea.value : null;
  return (
    <>
      <p class="eyebrow eyebrow--inline">Grid tariff</p>
      <div class="field">
        <span class="field__label pels-text-settings-label" id="electricity-prices-county-label">County</span>
        <MdFilledSelect
          value={config.countyCode}
          aria-labelledby="electricity-prices-county-label"
          onChange={(e) => handlers.onCountyChange(readValue(e))}
        >
          {COUNTIES.map((county) => (
            <MdSelectOption key={county.code} value={county.code}>
              <div slot="headline">{county.name}</div>
            </MdSelectOption>
          ))}
        </MdFilledSelect>
        {/* Only while there is no grid company: once there is one, the county is
            simply where that company operates. Plain, not alert: on its own the
            county changes no price. */}
        {!config.organizationNumber && assumedCounty !== null && (
          <small class="field__hint">
            {`Not chosen yet. Showing grid companies in ${COUNTIES.find((c) => c.code === assumedCounty)?.name ?? assumedCounty}.`}
          </small>
        )}
      </div>
      <div class="field">
        <span class="field__label pels-text-settings-label" id="electricity-prices-grid-company-label">Grid company</span>
        <MdFilledSelect
          value={config.organizationNumber || GRID_COMPANY_NONE}
          aria-labelledby="electricity-prices-grid-company-label"
          onChange={(e) => {
            const next = readValue(e);
            handlers.onOrganizationChange(next === GRID_COMPANY_NONE ? '' : next);
          }}
        >
          <MdSelectOption value={GRID_COMPANY_NONE}><div slot="headline">Select grid company</div></MdSelectOption>
          {gridCompanyOptions.map((c) => (
            <MdSelectOption key={c.organizationNumber} value={c.organizationNumber}>
              <div slot="headline">{c.name}</div>
            </MdSelectOption>
          ))}
        </MdFilledSelect>
        {!config.organizationNumber && (
          <NotChosenHint text="Not chosen yet, so your prices leave out the grid tariff." />
        )}
        {/* Dependency hint, not a label restatement: the list only shows the
            companies in the county selected above. */}
        <small class="field__hint">Filtered by county.</small>
      </div>
      <div class="field">
        <span class="field__label pels-text-settings-label" id="electricity-prices-tariff-group-label">Tariff group</span>
        <MdFilledSelect
          value={config.tariffGroup}
          aria-labelledby="electricity-prices-tariff-group-label"
          onChange={(e) => handlers.onTariffGroupChange(readValue(e))}
        >
          <MdSelectOption value="Husholdning"><div slot="headline">Household</div></MdSelectOption>
          <MdSelectOption value="Hytter og fritidshus">
            <div slot="headline">Cabin and holiday home</div>
          </MdSelectOption>
        </MdFilledSelect>
      </div>
      <div class="form__actions">
        <MdOutlinedButton type="button" onClick={handlers.onRefreshGridTariff}>
          Refresh tariffs
        </MdOutlinedButton>
      </div>

      <p class="eyebrow eyebrow--inline">Spot price</p>
      <div class="field">
        <span class="field__label pels-text-settings-label" id="electricity-prices-norway-model-label">Norway pricing model</span>
        <MdFilledSelect
          value={assumedModel === null ? config.norwayPriceModel : NOT_CHOSEN}
          aria-labelledby="electricity-prices-norway-model-label"
          onChange={(e) => {
            const next = readValue(e);
            if (next !== NOT_CHOSEN) handlers.onNorwayModelChange(normalizeNorwayPriceModel(next));
          }}
        >
          {assumedModel !== null && (
            <MdSelectOption value={NOT_CHOSEN}><div slot="headline">Select pricing model</div></MdSelectOption>
          )}
          <MdSelectOption value="stromstotte">
            <div slot="headline">Electricity Subsidy Scheme (Strømstøtte)</div>
          </MdSelectOption>
          <MdSelectOption value="norgespris">
            <div slot="headline">Norway Price (Norgespris)</div>
          </MdSelectOption>
        </MdFilledSelect>
        {assumedModel !== null && (
          <NotChosenHint text={`Not chosen yet. PELS uses ${NORWAY_PRICE_MODEL_NAMES[assumedModel]}.`} />
        )}
        {/* The consequence of the choice, not the option names again. */}
        <small class="field__hint">
          With Norgespris your electricity price is fixed, so only the grid tariff makes some hours cheaper.
        </small>
      </div>
      {config.norwayPriceModel === 'norgespris' && (
        <p class="muted">
          Official Norgespris rules are applied automatically: fixed spot target 50 øre/kWh incl. VAT.
          Monthly cap: household 5000 kWh, cabin 1000 kWh.
        </p>
      )}
      <div class="field">
        <span class="field__label pels-text-settings-label" id="electricity-prices-price-area-label">Price area</span>
        <MdFilledSelect
          value={assumedArea === null ? config.priceArea : NOT_CHOSEN}
          aria-labelledby="electricity-prices-price-area-label"
          onChange={(e) => {
            const next = readValue(e);
            if (next !== NOT_CHOSEN) handlers.onPriceAreaChange(next);
          }}
        >
          {assumedArea !== null && (
            <MdSelectOption value={NOT_CHOSEN}><div slot="headline">Select price area</div></MdSelectOption>
          )}
          <MdSelectOption value="NO1"><div slot="headline">NO1 — Oslo / East Norway</div></MdSelectOption>
          <MdSelectOption value="NO2"><div slot="headline">NO2 — Kristiansand / South Norway</div></MdSelectOption>
          <MdSelectOption value="NO3"><div slot="headline">NO3 — Trondheim / Central Norway</div></MdSelectOption>
          <MdSelectOption value="NO4"><div slot="headline">NO4 — Tromsø / North Norway (no VAT)</div></MdSelectOption>
          <MdSelectOption value="NO5"><div slot="headline">NO5 — Bergen / West Norway</div></MdSelectOption>
        </MdFilledSelect>
        {assumedArea !== null && <NotChosenHint text={`Not chosen yet. PELS uses ${assumedArea}.`} />}
        <small class="field__hint">
          {'Your electricity price area ('}
          <a href="https://www.hvakosterstrommen.no/" target="_blank" rel="noopener noreferrer">hvakosterstrommen.no</a>
          {').'}
        </small>
      </div>
      <label class="field">
        <span class="field__label pels-text-settings-label" id="electricity-prices-provider-surcharge-label">Provider surcharge</span>
        <MdFilledTextField
          type="number"
          value={String(config.providerSurcharge)}
          step="0.1"
          min="-100"
          max="100"
          suffix-text="øre/kWh"
          aria-labelledby="electricity-prices-provider-surcharge-label"
          onChange={(e) => {
            const val = readFiniteNumber(e);
            if (val !== null) handlers.onProviderSurchargeChange(val);
          }}
        />
        <small class="field__hint">Provider surcharge on top of spot price, incl. VAT. Can be negative.</small>
      </label>
    </>
  );
};

// The source as the Keep button names it, and as the hint above it does.
const SOURCE_NAMES: Record<PriceScheme, { short: string; inSentence: string }> = {
  norway: { short: 'Norway', inSentence: 'the Norway source' },
  flow: { short: 'Flow', inSentence: 'Flow' },
  homey: { short: 'Homey Energy', inSentence: 'Homey Energy' },
  powerhour: { short: 'Power by the Hour', inSentence: 'Power by the Hour' },
};

const ASSUMED_BECAUSE: Record<Extract<PriceSourceAssumption, { kind: 'assumed' }>['reason'], string> = {
  in_norway: 'Your Homey is in Norway, so ',
  outside_norway: 'Your Homey is outside Norway, so ',
  location_unknown: '',
};

type SourceStatusLines = { hint: ComponentChildren; followUp: ComponentChildren };

/**
 * What the owner needs to know about the source in force: a hint under the
 * select and, below the field, what to do about it. A source with no prices
 * says so first, whoever chose it. A source PELS assumed says so, with a button
 * to keep it: picking the value the select already shows fires no change, so
 * without one an owner happy with the assumption could never make it theirs.
 */
const resolveSourceStatusLines = (props: ElectricityPricesViewProps): SourceStatusLines => {
  const { config, handlers } = props;
  const name = SOURCE_NAMES[config.priceScheme];
  if (config.priceScheme === 'homey' && config.homeyStatus?.hasPrices === false) {
    return {
      hint: <small class="field__hint field__hint--alert">Homey Energy has no electricity prices for your Homey yet.</small>,
      followUp: (
        <p class="pels-card-supporting">
          Turn on dynamic prices in the Homey app under Energy &gt; Electricity, then press Refresh prices.
          Or choose another source above.
        </p>
      ),
    };
  }
  const assumption = props.sourceAssumption;
  if (assumption.kind === 'none') {
    return { hint: <small class="field__hint">Where PELS fetches price data.</small>, followUp: null };
  }
  return {
    hint: (
      <small class="field__hint field__hint--alert">
        {`Not chosen yet. ${ASSUMED_BECAUSE[assumption.reason]}PELS uses ${name.inSentence}.`}
      </small>
    ),
    followUp: (
      <div class="form__actions">
        <MdOutlinedButton type="button" onClick={handlers.onKeepSource}>{`Keep ${name.short}`}</MdOutlinedButton>
      </div>
    ),
  };
};

const SourceForm = (props: ElectricityPricesViewProps) => {
  const { config, handlers } = props;
  const note = schemeNote(config.priceScheme, config.organizationNumber !== '');
  const sourceStatus = resolveSourceStatusLines(props);
  const isNorway = config.priceScheme === 'norway';
  const isFlow = config.priceScheme === 'flow';
  const isHomey = config.priceScheme === 'homey';
  const isPowerhour = config.priceScheme === 'powerhour';

  return (
    <form class="form-grid settings-form-card" onSubmit={(e) => e.preventDefault()}>
      <h3 class="section-title">Price source</h3>
      <div class="field">
        <MdFilledSelect
          id="price-source-select"
          aria-label="Price source"
          value={config.priceScheme}
          onChange={(e) => handlers.onSchemeChange(normalizePriceSchemeSelection(readValue(e)))}
        >
          <MdSelectOption value="norway">
            <div slot="headline">Norway (spot + grid tariff)</div>
          </MdSelectOption>
          <MdSelectOption value="flow">
            <div slot="headline">Flow (prices from a Flow card)</div>
          </MdSelectOption>
          <MdSelectOption value="homey">
            <div slot="headline">Homey Energy (dynamic prices)</div>
          </MdSelectOption>
          <MdSelectOption value="powerhour">
            <div slot="headline">Power by the Hour (app)</div>
          </MdSelectOption>
        </MdFilledSelect>
        {sourceStatus.hint}
      </div>
      {sourceStatus.followUp}

      {note && <p class="muted">{note}</p>}
      {isFlow && config.flowStatus && <FlowStatusBlock status={config.flowStatus} />}
      {isHomey && config.homeyStatus && <HomeyStatusBlock status={config.homeyStatus} />}
      {isPowerhour && config.powerhourStatus && (
        <PowerhourStatusBlock
          status={config.powerhourStatus}
          pendingDeviceId={config.powerhourDeviceId}
          onDeviceChange={handlers.onPowerhourDeviceChange}
        />
      )}

      {isNorway && <NorwaySection {...props} />}

      {!isFlow && (
        <div class="form__actions">
          <MdOutlinedButton type="button" onClick={handlers.onRefreshPrices}>
            Refresh prices
          </MdOutlinedButton>
        </div>
      )}
    </form>
  );
};

// Where the forecast of the home's solar production comes from. Lives on the
// Electricity prices view because its output IS the planning price's surplus
// input (the `using your solar` reason line above); labels follow
// `notes/ui-terminology.md` — say what happens, no internal jargon.
const SolarForecastForm = ({ config, handlers }: {
  config: PriceConfigState;
  handlers: ElectricityPricesHandlers;
}) => (
  <form class="form-grid settings-form-card" onSubmit={(e) => e.preventDefault()}>
    <h3 class="section-title">Solar forecast</h3>
    <div class="field">
      <MdFilledSelect
        id="solar-forecast-source-select"
        aria-label="Solar forecast source"
        value={config.pvForecastSource}
        onChange={(e) => {
          const next = readValue(e);
          // The options below ARE the union, so a value outside it can only be a
          // malformed DOM read: a no-op, never a silent rewrite of the choice.
          if (isPvForecastSourceSetting(next)) handlers.onPvForecastSourceChange(next);
        }}
      >
        <MdSelectOption value="auto">
          <div slot="headline">Automatic</div>
        </MdSelectOption>
        <MdSelectOption value="homey_energy">
          <div slot="headline">Homey&rsquo;s solar forecast</div>
        </MdSelectOption>
        <MdSelectOption value="learned">
          <div slot="headline">Learned from your solar production</div>
        </MdSelectOption>
      </MdFilledSelect>
      <small class="field__hint">
        PELS plans cheap hours and solar surplus around this forecast of your
        solar production. Automatic uses Homey&rsquo;s forecast when Homey has
        forecast data, and the forecast PELS learns from your solar production
        otherwise.
      </small>
    </div>
    {config.pvForecastStatus.kind === 'selected'
      && <p class="muted">{resolvePvForecastStatusLine(config.pvForecastStatus)}</p>}
  </form>
);

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
const ExportPriceForm = ({ config, handlers }: {
  config: PriceConfigState;
  handlers: ElectricityPricesHandlers;
}) => {
  const {
    priceScheme, exportPriceEnabled, exportPriceSource, exportSpotFactor, exportFixed,
  } = config;
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
  // Homey holds export terms only for homes priced from Homey Energy, so that
  // is the only source where there is a choice to offer.
  const canReadFromHomey = priceScheme === 'homey';
  const usesHomeyTerms = canReadFromHomey && exportPriceSource === 'homey_energy';
  return (
    <form
      id="electricity-prices-export-section"
      class="form-grid settings-form-card"
      onSubmit={(e) => e.preventDefault()}
    >
      <h3 class="section-title">{EXPORT_PRICE_LABEL}</h3>
      <p class="muted">
        What you’re paid for power you send to the grid — check what your power company pays you.
        The Budget tab shows the current export price while this is on.
      </p>
      <label class="md-switch-row">
        <MdSwitch
          id="electricity-prices-export-enabled"
          aria-label="Use an export price"
          {...(exportPriceEnabled ? { selected: true } : {})}
          onChange={(e) => handlers.onExportEnabledChange((e.currentTarget as SwitchElement).selected)}
        />
        <span class="md-switch-row__content">
          <span class="md-switch-row__label pels-text-settings-label">Use an export price</span>
        </span>
      </label>
      {exportPriceEnabled && canReadFromHomey && (
        <div class="field">
          <span class="field__label pels-text-settings-label" id="electricity-prices-export-source-label">
            Where the price comes from
          </span>
          <MdFilledSelect
            id="electricity-prices-export-source"
            aria-labelledby="electricity-prices-export-source-label"
            value={exportPriceSource}
            onChange={(e) => handlers.onExportSourceChange(readValue(e) as ExportPriceSourceSetting)}
          >
            <MdSelectOption value="manual">
              <div slot="headline">Amounts I enter here</div>
            </MdSelectOption>
            <MdSelectOption value="homey_energy">
              <div slot="headline">Homey Energy</div>
            </MdSelectOption>
          </MdFilledSelect>
          <small class="field__hint">
            {usesHomeyTerms
              ? 'PELS uses the feed-in price set up in Homey under Energy > Electricity.'
              : 'PELS uses the amounts below.'}
          </small>
        </div>
      )}
      {exportPriceEnabled && !usesHomeyTerms && (
        <>
          <label class="field">
            <span class="field__label pels-text-settings-label" id="electricity-prices-export-spot-factor-label">
              Share of spot price
            </span>
            <MdFilledTextField
              id="electricity-prices-export-spot-factor"
              type="number"
              value={String(exportSpotFactor)}
              min={String(EXPORT_SPOT_FACTOR_MIN)}
              max={String(EXPORT_SPOT_FACTOR_MAX)}
              step="1"
              suffix-text="%"
              inputmode="decimal"
              {...(shareEditable ? {} : { disabled: true })}
              aria-labelledby="electricity-prices-export-spot-factor-label"
              onChange={(e) => {
                const val = readFiniteNumber(e);
                // Pass the element so a rejected value can be snapped back:
                // Preact's retained VDOM won't rewrite a value prop that
                // didn't change, so the handler resets it imperatively.
                if (val !== null) handlers.onExportSpotFactorChange(val, e.currentTarget as ValueElement);
              }}
            />
            <small class="field__hint">
              {spotShareHint(hasSpotPrice, staleSpotShare)}
            </small>
          </label>
          <label class="field">
            <span class="field__label pels-text-settings-label" id="electricity-prices-export-fixed-label">
              Fixed amount
            </span>
            <MdFilledTextField
              id="electricity-prices-export-fixed"
              type="number"
              value={String(exportFixed)}
              min={String(-EXPORT_FIXED_LIMIT)}
              max={String(EXPORT_FIXED_LIMIT)}
              step="0.1"
              {...(hasSpotPrice ? { 'suffix-text': 'øre/kWh' } : {})}
              inputmode="decimal"
              aria-labelledby="electricity-prices-export-fixed-label"
              onChange={(e) => {
                const val = readFiniteNumber(e);
                // Same snap-back contract as the spot-share field above.
                if (val !== null) handlers.onExportFixedChange(val, e.currentTarget as ValueElement);
              }}
            />
            <small class="field__hint">
              {hasSpotPrice
                ? 'Added for every exported kWh, incl. VAT. Negative means you pay to export.'
                : 'Added for every exported kWh, in the same unit as your prices. Negative means you pay to export.'}
            </small>
          </label>
        </>
      )}
    </form>
  );
};

const ThresholdForm = ({ config, handlers }: {
  config: PriceConfigState;
  handlers: ElectricityPricesHandlers;
}) => (
  <form class="form-grid settings-form-card" onSubmit={(e) => e.preventDefault()}>
    <h3 class="section-title">Cheap and expensive prices</h3>
    <p class="muted">Defines what counts as cheap or expensive.</p>
    <label class="field">
      <span class="field__label pels-text-settings-label" id="electricity-prices-threshold-label">Price threshold</span>
      <MdFilledTextField
        type="number"
        value={String(config.thresholdPercent)}
        min="5"
        max="50"
        step="1"
        suffix-text="%"
        aria-labelledby="electricity-prices-threshold-label"
        onChange={(e) => {
          const val = readFiniteNumber(e);
          if (val !== null) handlers.onThresholdChange(val);
        }}
      />
      <small class="field__hint">Hours this % below or above average are marked cheap or expensive.</small>
    </label>
    <label class="field">
      <span class="field__label pels-text-settings-label" id="electricity-prices-min-diff-label">
        Minimum price difference
      </span>
      <MdFilledTextField
        type="number"
        value={String(config.minDiffOre)}
        min="0"
        max="1000"
        step="any"
        {...(config.priceScheme === 'norway' ? { 'suffix-text': 'øre/kWh' } : {})}
        inputmode="decimal"
        aria-labelledby="electricity-prices-min-diff-label"
        onChange={(e) => {
          const val = readFiniteNumber(e);
          if (val !== null) handlers.onMinDiffChange(val);
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

const ElectricityPricesRoot = (props: ElectricityPricesViewProps) => (
  <>
    <Header />
    <LiveSummaryCard config={props.config} />
    <SourceForm {...props} />
    {props.showSolarForecastSection && <SolarForecastForm config={props.config} handlers={props.handlers} />}
    {props.showExportSection && <ExportPriceForm config={props.config} handlers={props.handlers} />}
    <ThresholdForm config={props.config} handlers={props.handlers} />
    <PriceAwareDevicesLink />
  </>
);

export const renderElectricityPricesView = (
  surface: HTMLElement,
  props: ElectricityPricesViewProps,
): void => {
  render(<ElectricityPricesRoot {...props} />, surface);
};
