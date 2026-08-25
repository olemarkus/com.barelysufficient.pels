import './materialWeb.ts';
import {
  callApi,
  getApiReadModel,
  getSetting,
  primeApiCache,
  setSetting,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { state, defaultPriceOptimizationConfig, type SettingsUiDeviceView } from './state.ts';
import { supportsTemperatureDevice } from './deviceUtils.ts';
import { resolveManagedState, resolveHomeExhibitsSolar } from './state.ts';
import { gridCompanies } from './gridCompanies.ts';
import { readCurrentPriceSettings } from './priceSettingsPersistence.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import {
  applyExportSchemeChangePlan,
  createExportPriceHandlers,
  recoverFromSchemeChangeFailure,
  resolveExportSchemeChangePlan,
} from './exportPriceSettings.ts';
import {
  readPriceConfigSettings,
  validateAndSavePriceSettings as saveValidatedPriceSettings,
} from './priceConfigSettingsIo.ts';
import { PRICE_OPTIMIZATION_ENABLED } from '../../../contracts/src/settingsKeys.ts';
import {
  SETTINGS_UI_POWER_PATH,
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  SETTINGS_UI_REFRESH_PRICES_PATH,
  type SettingsUiPowerPayload,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { buildFlowStatus, buildHomeyStatus } from './priceConfigStatus.ts';
import { resolveLiveSummarySignals } from './livePriceSignals.ts';
import {
  renderElectricityPricesView,
  type ElectricityPricesViewProps,
} from './views/ElectricityPricesView.tsx';
import {
  renderPriceAwareDevicesView,
  type PriceAwareDevicesViewProps,
} from './views/PriceAwareDevicesView.tsx';
import type {
  PriceConfigState,
  PriceOptDevice,
  GridCompanyOption,
  PriceScheme,
  NorwayPriceModel,
} from './priceConfigTypes.ts';
import { liveStatusOrNull } from './powerStatusRead.ts';

let configState: PriceConfigState = {
  optimizationEnabled: true,
  thresholdPercent: 25,
  minDiffOre: 0,
  priceScheme: 'norway',
  norwayPriceModel: 'stromstotte',
  priceArea: 'NO1',
  providerSurcharge: 0,
  countyCode: '03',
  organizationNumber: '',
  tariffGroup: 'Husholdning',
  flowStatus: null,
  homeyStatus: null,
  currentPriceLevel: null,
  liveSummary: { lastFetchedShort: null, exportText: null, planningReasonLine: null },
  exportPriceEnabled: false,
  exportSpotFactor: 0,
  exportFixed: 0,
};

let electricityPricesSurface: HTMLElement | null = null;
let priceAwareDevicesSurface: HTMLElement | null = null;
let settingsLoaded = false;

const getGridCompanyOptions = (countyCode: string): GridCompanyOption[] => (
  gridCompanies
    .filter((c) => c.countyCodes.includes(countyCode))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, organizationNumber: c.organizationNumber }))
);

const buildPriceOptDevices = (devices: SettingsUiDeviceView[]): PriceOptDevice[] => (
  devices
    .filter((d) => {
      const cfg = state.priceOptimizationSettings[d.id];
      return resolveManagedState(d.id) && cfg?.enabled === true && supportsTemperatureDevice(d);
    })
    .map((d) => {
      const cfg = state.priceOptimizationSettings[d.id] || { ...defaultPriceOptimizationConfig };
      return { id: d.id, name: d.name, cheapDelta: cfg.cheapDelta, expensiveDelta: cfg.expensiveDelta };
    })
);

const renderElectricityPrices = () => {
  if (!electricityPricesSurface) return;
  const props: ElectricityPricesViewProps = {
    thresholdPercent: configState.thresholdPercent,
    minDiffOre: configState.minDiffOre,
    priceScheme: configState.priceScheme,
    norwayPriceModel: configState.norwayPriceModel,
    priceArea: configState.priceArea,
    providerSurcharge: configState.providerSurcharge,
    countyCode: configState.countyCode,
    organizationNumber: configState.organizationNumber,
    tariffGroup: configState.tariffGroup,
    flowStatus: configState.flowStatus,
    homeyStatus: configState.homeyStatus,
    currentPriceLevel: configState.currentPriceLevel,
    lastFetchedShort: configState.liveSummary.lastFetchedShort,
    // Gate the live export/planning signals on the CURRENT enabled setting, not
    // the cached prices: `combined_prices` keeps carrying exportPrice/budgetPrice
    // for up to an hour after the user turns export pricing off (the prices only
    // drop them on the next rebuild), and `onEnabledChange` repaints without
    // recomputing `liveSummary`. Reading the live flag here suppresses the export
    // row and the `using your solar` reason line the instant the toggle flips —
    // an enabled user is byte-identical.
    currentExportPriceText: configState.exportPriceEnabled ? configState.liveSummary.exportText : null,
    planningPriceReasonLine: configState.exportPriceEnabled ? configState.liveSummary.planningReasonLine : null,
    gridCompanyOptions: getGridCompanyOptions(configState.countyCode),
    showPriceAwareDevicesLink: false,
    // Prosumer gate: any home that exhibits solar — a managed solar device OR
    // material exhibited grid export (a meter-only / string-inverter home) — OR
    // an already-enabled export config, so an enabled user is never stranded
    // behind the gate. Source-blind: both power sources report signed net, so a
    // flow home exhibits export on the same evidence as a Homey Energy one.
    //
    // NOT in lockstep with the surplus-toggle gate any more: that one asks the
    // narrower "can the surplus POOL open" question (`surplusPoolReachable`),
    // while a fixed feed-in amount needs no pool at all.
    showExportSection: resolveHomeExhibitsSolar() || configState.exportPriceEnabled,
    exportPriceEnabled: configState.exportPriceEnabled,
    exportSpotFactor: configState.exportSpotFactor,
    exportFixed: configState.exportFixed,
    onSchemeChange: handleSchemeChange,
    onNorwayModelChange: handleNorwayModelChange,
    onPriceAreaChange: handlePriceAreaChange,
    onProviderSurchargeChange: handleProviderSurchargeChange,
    onThresholdChange: handleThresholdChange,
    onMinDiffChange: handleMinDiffChange,
    onCountyChange: handleCountyChange,
    onOrganizationChange: handleOrganizationChange,
    onTariffGroupChange: handleTariffGroupChange,
    onRefreshPrices: handleRefreshPrices,
    onRefreshGridTariff: handleRefreshGridTariff,
    onExportEnabledChange: exportPriceHandlers.onEnabledChange,
    onExportSpotFactorChange: exportPriceHandlers.onSpotFactorChange,
    onExportFixedChange: exportPriceHandlers.onFixedChange,
  };
  renderElectricityPricesView(electricityPricesSurface, props);
};

const renderPriceAwareDevices = () => {
  if (!priceAwareDevicesSurface) return;
  const props: PriceAwareDevicesViewProps = {
    optimizationEnabled: configState.optimizationEnabled,
    devices: buildPriceOptDevices(state.latestDevices),
    onOptimizationToggle: handleOptimizationToggle,
    onDeviceCheapDeltaChange: handleDeviceCheapDeltaChange,
    onDeviceExpensiveDeltaChange: handleDeviceExpensiveDeltaChange,
  };
  renderPriceAwareDevicesView(priceAwareDevicesSurface, props);
};

const renderAll = () => {
  renderElectricityPrices();
  renderPriceAwareDevices();
};

const validateAndSavePriceSettings = async () => {
  await saveValidatedPriceSettings(configState);
};

const handleOptimizationToggle = async (enabled: boolean) => {
  configState = { ...configState, optimizationEnabled: enabled };
  renderAll();
  try {
    await setSetting(PRICE_OPTIMIZATION_ENABLED, enabled);
    await showToast(enabled ? 'Price optimization enabled.' : 'Price optimization disabled.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to update price optimization', error, 'priceConfig');
    await showToastError(error, 'Failed to update price optimization setting.');
  }
};

const handleSchemeChange = async (scheme: PriceScheme) => {
  // Crossing the Norway unit boundary in either direction changes what an
  // enabled export config means — a fixed amount can't cross it (export turns
  // off) and a spot-linked share has no spot on flow/homey (share normalizes
  // to 0). See exportPriceSettings.ts for the full rationale.
  // Only the scheme is patched optimistically; export state mutates strictly
  // AFTER its follow-up write lands, so a failed save never shows a state the
  // store does not hold.
  configState = { ...configState, priceScheme: scheme };
  renderAll();
  // The scheme save and the export follow-up cannot be atomic. Track the scheme
  // read before the save (`previousScheme`) and whether the scheme write landed
  // (`schemePersisted`); on any failure `recoverFromSchemeChangeFailure` decides
  // how to reconcile the store + optimistic UI (roll back a landed scheme, revert
  // a never-persisted one, and never clobber a newer selection or the export config).
  let previousScheme: PriceScheme | undefined;
  let schemePersisted = false;
  try {
    // The plan resolves against the PERSISTED scheme, not the optimistic UI
    // one: the stored fixed amount's unit follows the scheme active when it
    // was entered, and after a failed save the two can diverge.
    ({ priceScheme: previousScheme } = await readCurrentPriceSettings());
    const exportPlan = resolveExportSchemeChangePlan({ ...configState, previousScheme, nextScheme: scheme });
    await validateAndSavePriceSettings();
    schemePersisted = true;
    // Export follow-up write runs only after the scheme save itself landed —
    // if it failed, the store never changed scheme and disabling/zeroing
    // would silently degrade a live export config.
    const { patch, toast } = await applyExportSchemeChangePlan(exportPlan);
    configState = { ...configState, ...patch };
    await refreshStatusInfo();
    renderAll();
    await showToast(toast, 'ok');
  } catch (error) {
    // A failed change: reconcile the store + optimistic UI (the helper guards a
    // newer selection and never wipes the export config).
    const rolled = await recoverFromSchemeChangeFailure({
      scheme, currentScheme: configState.priceScheme, previousScheme, schemePersisted,
    });
    if (rolled && previousScheme !== undefined) configState = { ...configState, priceScheme: previousScheme };
    // Repaint so the view reflects the stored export config (and any rollback).
    renderAll();
    await logSettingsError('Failed to save price scheme', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleNorwayModelChange = async (model: NorwayPriceModel) => {
  configState = { ...configState, norwayPriceModel: model };
  renderAll();
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save Norway price model', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handlePriceAreaChange = async (area: string) => {
  configState = { ...configState, priceArea: area };
  renderAll();
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save price area', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleProviderSurchargeChange = async (val: number) => {
  configState = { ...configState, providerSurcharge: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save provider surcharge', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleThresholdChange = async (val: number) => {
  configState = { ...configState, thresholdPercent: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save price threshold', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleMinDiffChange = async (val: number) => {
  configState = { ...configState, minDiffOre: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save min diff', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings. If this keeps happening, send a diagnostics report.');
  }
};

const handleCountyChange = async (code: string) => {
  configState = { ...configState, countyCode: code, organizationNumber: '' };
  renderAll();
  try {
    await setSetting('nettleie_fylke', code);
  } catch (error) {
    await logSettingsError('Failed to save county', error, 'priceConfig');
    await showToastError(error, 'Failed to save grid tariff settings.');
  }
};

const handleOrganizationChange = async (orgNumber: string) => {
  configState = { ...configState, organizationNumber: orgNumber };
  try {
    const [currentCounty, currentOrg, currentGroup] = await Promise.all([
      getSetting('nettleie_fylke'),
      getSetting('nettleie_orgnr'),
      getSetting('nettleie_tariffgruppe'),
    ]);
    const writes: Array<Promise<void>> = [];
    pushSettingWriteIfChanged(writes, 'nettleie_fylke', currentCounty, configState.countyCode);
    pushSettingWriteIfChanged(writes, 'nettleie_orgnr', currentOrg, orgNumber);
    pushSettingWriteIfChanged(writes, 'nettleie_tariffgruppe', currentGroup, configState.tariffGroup);
    if (writes.length > 0) {
      await Promise.all(writes);
      const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
      primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? null);
    }
    await showToast('Grid tariff settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save organization', error, 'priceConfig');
    await showToastError(error, 'Failed to save grid tariff settings.');
  }
};

const handleTariffGroupChange = async (group: string) => {
  configState = { ...configState, tariffGroup: group };
  try {
    await setSetting('nettleie_tariffgruppe', group);
    await showToast('Grid tariff settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save tariff group', error, 'priceConfig');
    await showToastError(error, 'Failed to save grid tariff settings.');
  }
};

// Export-section handlers live in exportPriceSettings.ts; config state and the
// surface repaint stay owned here via the context callbacks.
const exportPriceHandlers = createExportPriceHandlers({
  getState: () => configState,
  patchState: (patch) => { configState = { ...configState, ...patch }; },
  rerender: () => renderElectricityPrices(),
});

const handleDeviceCheapDeltaChange = async (deviceId: string, val: number) => {
  const existing = state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig };
  const previousCheapDelta = existing.cheapDelta;
  state.priceOptimizationSettings[deviceId] = { ...existing, cheapDelta: val };
  renderPriceAwareDevices();
  try {
    await setSetting('price_optimization_settings', state.priceOptimizationSettings);
  } catch (error) {
    // Roll back only this device's `cheapDelta`, and only if a later
    // successful save has not already overwritten it. Replacing the whole
    // map (the earlier approach) clobbered newer persisted edits from
    // overlapping handlers (TODO 735 follow-up).
    const current = state.priceOptimizationSettings[deviceId];
    if (current && current.cheapDelta === val) {
      state.priceOptimizationSettings[deviceId] = { ...current, cheapDelta: previousCheapDelta };
      renderPriceAwareDevices();
    }
    await logSettingsError('Failed to save cheap delta', error, 'priceConfig');
    await showToastError(error, 'Failed to save price optimization setting.');
  }
};

const handleDeviceExpensiveDeltaChange = async (deviceId: string, val: number) => {
  const existing = state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig };
  const previousExpensiveDelta = existing.expensiveDelta;
  state.priceOptimizationSettings[deviceId] = { ...existing, expensiveDelta: val };
  renderPriceAwareDevices();
  try {
    await setSetting('price_optimization_settings', state.priceOptimizationSettings);
  } catch (error) {
    // Same field-level rollback rationale as `cheapDelta` above.
    const current = state.priceOptimizationSettings[deviceId];
    if (current && current.expensiveDelta === val) {
      state.priceOptimizationSettings[deviceId] = { ...current, expensiveDelta: previousExpensiveDelta };
      renderPriceAwareDevices();
    }
    await logSettingsError('Failed to save expensive delta', error, 'priceConfig');
    await showToastError(error, 'Failed to save price optimization setting.');
  }
};

const handleRefreshPrices = async () => {
  try {
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_PRICES_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response);
    await refreshStatusInfo();
    renderAll();
  } catch (error) {
    await logSettingsError('Failed to refresh prices', error, 'priceConfig');
    await showToastError(error, 'Failed to refresh spot prices. If this keeps happening, send a diagnostics report.');
  }
};

const handleRefreshGridTariff = async () => {
  try {
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? null);
    await showToast('Grid tariffs refreshed.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to refresh grid tariff', error, 'priceConfig');
    await showToastError(error, 'Failed to refresh grid tariffs. If this keeps happening, send a diagnostics report.');
  }
};

const refreshStatusInfo = async () => {
  try {
    const [pricesPayload, powerPayload] = await Promise.all([
      getApiReadModel<SettingsUiPricesPayload>(SETTINGS_UI_PRICES_PATH),
      getApiReadModel<SettingsUiPowerPayload>(SETTINGS_UI_POWER_PATH),
    ]);
    const payload = pricesPayload ?? {
      combinedPrices: null, electricityPrices: null, priceArea: null, gridTariffData: null,
      flowToday: null, flowTomorrow: null, homeyCurrency: null, homeyToday: null, homeyTomorrow: null,
    };
    configState = {
      ...configState,
      flowStatus: configState.priceScheme === 'flow' ? buildFlowStatus(payload) : null,
      homeyStatus: configState.priceScheme === 'homey' ? buildHomeyStatus(payload) : null,
      // Same `priceLevel` field the budget hero reads, so the tier chip never
      // disagrees across surfaces.
      currentPriceLevel: liveStatusOrNull(powerPayload?.status)?.priceLevel ?? null,
      liveSummary: resolveLiveSummarySignals(payload.combinedPrices, Date.now()),
    };
  } catch (error) {
    await logSettingsError('Failed to refresh price status', error, 'priceConfig');
  }
};

const loadPriceConfigSettings = async () => {
  // Read FIRST, then merge. Spreading `configState` inside the same literal as
  // the `await` would snapshot it before the 12 settings round trips and revert
  // anything `refreshStatusInfo` wrote meanwhile (both run concurrently off a
  // `price_scheme` change), leaving the "Right now" card stale for the session.
  const patch = await readPriceConfigSettings();
  configState = { ...configState, ...patch };
  settingsLoaded = true;
};

const ensureLoaded = async () => {
  if (!settingsLoaded) await loadPriceConfigSettings();
};

export const updatePriceConfigDevices = (devices: SettingsUiDeviceView[]) => {
  state.latestDevices = devices;
  renderPriceAwareDevices();
  // The devices payload also carries the home-level managed-solar flag that
  // gates the export-price section, so the prices view must repaint too.
  renderElectricityPrices();
};

export const refreshPriceConfigView = async () => {
  await refreshStatusInfo();
  renderAll();
};

export const reloadPriceConfigSettings = async () => {
  await loadPriceConfigSettings();
  renderAll();
};

export const initElectricityPricesView = async (surface: HTMLElement) => {
  electricityPricesSurface = surface;
  await ensureLoaded();
  await refreshStatusInfo();
  renderElectricityPrices();
};

export const initPriceAwareDevicesView = async (surface: HTMLElement) => {
  priceAwareDevicesSurface = surface;
  await ensureLoaded();
  renderPriceAwareDevices();
};
